import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'
import { signedInUser, TEST_TOKEN_KEY } from './helpers/lms-context.js'
import { createTokenCipher, CIPHER_CONTEXTS, TokenDecryptError } from '../src/lms/token-cipher.js'
import { MAX_PUSH_SUBSCRIPTIONS_PER_USER } from '../src/push/push-subscription-service.js'
import { createPushEndpointHasher } from '../src/push/push-endpoint-hash.js'
import {
  buildPushApp, makeSubscription, subscriptionBody, pushRows, decryptRow, pushCipher,
  PUBLIC_KEY_PATH, SUBSCRIPTIONS_PATH, PUSH_TEST_PATH, TEST_PUSH_CONFIG,
} from './helpers/push-context.js'

// 등록 트랜잭션 두 개를 겹치게 하는 풀(실제 타이머 없음). arm() 뒤 얻은 연결만 센다
function createRaceGatedPool(pool) {
  let armed = false
  let order = 0
  let released = false
  let release
  const gate = new Promise((resolve) => {
    release = () => {
      released = true
      resolve()
    }
  })
  const isLimitCheck = (sql) => String(sql).includes('ORDER BY COALESCE(last_success_at, created_at)')
  const wrap = (connection, index) =>
    new Proxy(connection, {
      get(target, prop) {
        if (prop !== 'execute') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop]
        return async (sql, params) => {
          if (index === 2 && /FROM users WHERE id = \? FOR UPDATE/.test(sql)) release()
          const result = await target.execute(sql, params)
          if (index === 1 && isLimitCheck(sql)) await gate
          if (index === 2 && isLimitCheck(sql)) release()
          return result
        }
      },
    })
  const gatedPool = new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'getConnection') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop]
      return async () => {
        const connection = await target.getConnection()
        if (!armed) return connection
        order += 1
        return wrap(connection, order)
      }
    },
  })
  return { pool: gatedPool, arm: () => { armed = true }, raced: () => released }
}

// 구독 API (ADR 0012): 내 것만, endpoint당 한 행(같은 브라우저에서 다른 계정이 등록하면 주인 이전 · 새 주인 기준으로 다시 암호화),
// 사용자당 10개(넘으면 같은 사용자 안에서 가장 오래 성공 못 한 것 교체), 원문은 저장 안 함
describe('푸시 구독 API (/api/push)', () => {
  let ctx
  let built
  let a
  let b

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    built = buildPushApp(ctx)
    a = await signedInUser(built.app, 'a@example.com')
    b = await signedInUser(built.app, 'b@example.com')
  })
  after(async () => {
    await ctx.close()
  })

  const register = (user, sub) => user.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody(sub))
  const unregister = (user, endpoint) => user.agent.delete(SUBSCRIPTIONS_PATH).send({ endpoint })

  it('공개키는 로그인 없이 { publicKey }, 구독 · 해제 · 테스트 발송은 로그인 필요(401)', async () => {
    const anonymous = request(built.app)
    assert.deepEqual((await anonymous.get(PUBLIC_KEY_PATH).expect(200)).body, { publicKey: TEST_PUSH_CONFIG.vapidPublicKey })
    await anonymous.post(SUBSCRIPTIONS_PATH).send(subscriptionBody(makeSubscription())).expect(401)
    await anonymous.delete(SUBSCRIPTIONS_PATH).send({ endpoint: 'https://fcm.googleapis.com/x' }).expect(401)
    await anonymous.post(PUSH_TEST_PATH).expect(401)
  })

  it('등록 → 201, 행에는 암호문 · 키 있는 해시만(원문 없음), 내 id 기준으로 풀면 endpoint · 키 그대로', async () => {
    const sub = makeSubscription()

    const res = await register(a, sub).expect(201)

    assert.deepEqual(res.body, {})
    const [row] = await pushRows(ctx.pool)
    assert.equal(row.user_id, a.userId)
    assert.match(row.endpoint_hash, /^[0-9a-f]{64}$/)
    assert.notEqual(row.endpoint_hash, createHash('sha256').update(sub.endpoint).digest('hex'), '키 없는 해시가 아님')
    // 5단계에서 더함(백업과 다름): 키가 바뀌면 해시도 바뀐다(키에 기대는 HMAC), 저장된 값은 앱 키로 만든 것
    assert.equal(row.endpoint_hash, createPushEndpointHasher({ key: TEST_TOKEN_KEY })(sub.endpoint))
    assert.notEqual(createPushEndpointHasher({ key: TEST_TOKEN_KEY })(sub.endpoint), createPushEndpointHasher({ key: Buffer.alloc(32, 1) })(sub.endpoint))
    assert.ok(row.subscription_enc.startsWith('v1:'))
    for (const secret of [sub.endpoint, sub.keys.p256dh, sub.keys.auth, sub.endpoint.split('/').at(-1)]) {
      assert.ok(!row.subscription_enc.includes(secret))
    }
    assert.deepEqual(decryptRow(row, a.userId), { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
  })

  it('같은 endpoint 재등록(키 갱신) → 200, 행 하나 · 같은 id, 새 키로', async () => {
    const sub = makeSubscription()
    await register(a, sub).expect(201)
    const [before] = await pushRows(ctx.pool)
    const refreshed = { ...makeSubscription(), endpoint: sub.endpoint }

    assert.deepEqual((await register(a, refreshed).expect(200)).body, {})

    const rows = await pushRows(ctx.pool)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, before.id)
    assert.deepEqual(decryptRow(rows[0]), { endpoint: sub.endpoint, p256dh: refreshed.keys.p256dh, auth: refreshed.keys.auth })
  })

  it('주인 이전: A가 등록한 endpoint를 B가 같은 브라우저에서 등록 → 행 하나 · 주인 B, B 기준으로만 풀리고 A 기준으로는 안 풀림, A는 더 못 지운다', async () => {
    const sub = makeSubscription()
    await register(a, sub).expect(201)

    await register(b, sub).expect(200)

    const rows = await pushRows(ctx.pool)
    assert.deepEqual(rows.map((r) => r.user_id), [b.userId])
    assert.equal(decryptRow(rows[0], b.userId).endpoint, sub.endpoint)
    assert.throws(() => decryptRow(rows[0], a.userId), TokenDecryptError, 'A 기준 AAD로는 풀리면 안 됨(새 주인 기준으로 다시 암호화)')
    assert.equal((await unregister(a, sub.endpoint).expect(404)).body.error, 'push_subscription_not_found')
    assert.equal((await pushRows(ctx.pool)).length, 1)
  })

  it('암호문 용도 구분: 구독 AAD는 push_subscription:<id>, Canvas 토큰 · iCloud 링크 암호문은 구독 용도로 안 풀리고 반대도 안 됨', () => {
    assert.equal(CIPHER_CONTEXTS.pushSubscription(7), 'push_subscription:7')
    assert.equal(new Set([CIPHER_CONTEXTS.lmsToken(7), CIPHER_CONTEXTS.icloudLink(7), CIPHER_CONTEXTS.pushSubscription(7)]).size, 3)
    const plain = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a' })
    const others = [CIPHER_CONTEXTS.lmsToken, CIPHER_CONTEXTS.icloudLink].map((context) => createTokenCipher({ key: TEST_TOKEN_KEY, context }))
    for (const other of others) {
      assert.throws(() => pushCipher().decrypt(other.encrypt(plain, { userId: 7 }), { userId: 7 }), TokenDecryptError)
      assert.throws(() => other.decrypt(pushCipher().encrypt(plain, { userId: 7 }), { userId: 7 }), TokenDecryptError)
    }
  })

  it(`사용자당 ${MAX_PUSH_SUBSCRIPTIONS_PER_USER}개: 넘으면 같은 사용자 안에서 가장 오래 성공 못 한 것(마지막 성공 → 만든 시각) 교체, 다른 사용자 구독은 그대로`, async () => {
    assert.equal(MAX_PUSH_SUBSCRIPTIONS_PER_USER, 10)
    const mine = []
    for (let i = 0; i < 10; i += 1) {
      mine.push(makeSubscription())
      await register(a, mine.at(-1)).expect(201)
    }
    const theirs = [makeSubscription(), makeSubscription(), makeSubscription()]
    for (const sub of theirs) await register(b, sub).expect(201)
    const rowsA = await pushRows(ctx.pool, a.userId)
    // 기준을 정해 둔다: 모두 11-15에 성공, 4번째만 성공한 적 없고 11-01에 만듦 → 그것이 가장 오래 성공 못 한 구독
    await ctx.pool.query("UPDATE push_subscriptions SET created_at = '2026-11-10 00:00:00', last_success_at = '2026-11-15 00:00:00' WHERE user_id = ?", [a.userId])
    await ctx.pool.query("UPDATE push_subscriptions SET created_at = '2026-11-01 00:00:00', last_success_at = NULL WHERE id = ?", [rowsA[3].id])
    // 다른 사용자 구독: 하나는 더 오래됐고(10-01) 둘은 더 새것(11-20) — 사용자 구분 없이 고르면 어느 쪽이든 결과가 틀어진다(5단계에서 보강)
    const rowsB = await pushRows(ctx.pool, b.userId)
    await ctx.pool.query("UPDATE push_subscriptions SET created_at = '2026-10-01 00:00:00', last_success_at = NULL WHERE id = ?", [rowsB[0].id])
    await ctx.pool.query("UPDATE push_subscriptions SET created_at = '2026-11-20 00:00:00', last_success_at = NULL WHERE id IN (?)", [rowsB.slice(1).map((r) => r.id)])

    await register(a, makeSubscription()).expect(201)

    const after = await pushRows(ctx.pool, a.userId)
    assert.equal(after.length, 10)
    assert.ok(!after.some((r) => r.id === rowsA[3].id), '가장 오래 성공 못 한 구독이 교체됨')
    assert.equal((await pushRows(ctx.pool, b.userId)).length, 3, '다른 사용자 구독은 그대로(더 오래됐어도 · 더 새것이어도)')
  })

  // 5단계에서 더함(백업에 없던 테스트, 뮤턴트 "users 행 잠금 빼기"가 살아남아서): 동시 등록에도 상한을 넘지 않는다.
  // 첫 트랜잭션을 "상한 확인 조회" 직후 멈춰 두고, 두 번째가 users 행 잠금을 요청하거나(잠금이 있으면 거기서 기다림) 상한 확인까지 마치면(잠금이 없으면) 풀어 준다
  it(`동시 등록: ${MAX_PUSH_SUBSCRIPTIONS_PER_USER - 1}개인 사용자가 동시에 2개 등록해도 ${MAX_PUSH_SUBSCRIPTIONS_PER_USER}개를 넘지 않는다`, async () => {
    const gated = createRaceGatedPool(ctx.pool)
    const raced = buildPushApp(ctx, { pool: gated.pool })
    const user = await signedInUser(raced.app, 'race@example.com')
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER - 1; i += 1) await user.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody(makeSubscription())).expect(201)
    gated.arm()

    await Promise.all([1, 2].map(() => user.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody(makeSubscription())).expect(201)))

    assert.equal((await pushRows(ctx.pool, user.userId)).length, MAX_PUSH_SUBSCRIPTIONS_PER_USER)
    assert.equal(gated.raced(), true, '전제: 두 트랜잭션이 실제로 겹쳤다')
  })

  it('해제: 내 구독 → 204 · 행 삭제, 다시 · 남의 것 · 허용 목록 밖 주소 → 404 push_subscription_not_found, endpoint 없음 → 400', async () => {
    const mine = makeSubscription()
    const theirs = makeSubscription()
    await register(a, mine).expect(201)
    await register(b, theirs).expect(201)

    await unregister(a, mine.endpoint).expect(204)
    for (const endpoint of [mine.endpoint, theirs.endpoint, 'https://evil.example/x']) {
      assert.equal((await unregister(a, endpoint).expect(404)).body.error, 'push_subscription_not_found', endpoint)
    }
    assert.deepEqual((await pushRows(ctx.pool)).map((r) => r.user_id), [b.userId], '남의 구독은 그대로')
    assert.deepEqual((await a.agent.delete(SUBSCRIPTIONS_PATH).send({}).expect(400)).body.field, 'endpoint')
  })

  it('입력 검사 실패 → 400 { error, field, message }, 아무것도 저장하지 않음', async () => {
    const sub = makeSubscription()
    const cases = [
      [{ ...subscriptionBody(sub), endpoint: sub.endpoint.replace('https:', 'http:') }, 'insecure_endpoint', 'endpoint'],
      [{ ...subscriptionBody(sub), endpoint: 'https://fcm.googleapis.com.evil.com/x' }, 'push_service_not_allowed', 'endpoint'],
      [{ ...subscriptionBody(sub), keys: { ...sub.keys, p256dh: 'short' } }, 'invalid_p256dh', 'keys.p256dh'],
      [{ endpoint: sub.endpoint }, 'missing_keys', 'keys'],
    ]
    for (const [payload, error, field] of cases) {
      const res = await a.agent.post(SUBSCRIPTIONS_PATH).send(payload).expect(400)
      assert.deepEqual([res.body.error, res.body.field, typeof res.body.message], [error, field, 'string'])
      assert.ok(!JSON.stringify(res.body).includes(sub.keys.auth))
    }
    assert.equal((await pushRows(ctx.pool)).length, 0)
  })

  it('테스트 발송(개발용): 202 { queued } → 내 구독마다 한 번, 남의 구독에는 안 감. 운영 설정이면 라우트가 없다(404)', async () => {
    const mine = [makeSubscription(), makeSubscription({ host: 'web.push.apple.com', path: '/QOk1TestExample' })]
    for (const sub of mine) await register(a, sub).expect(201)
    const theirs = makeSubscription()
    await register(b, theirs).expect(201)

    assert.deepEqual((await a.agent.post(PUSH_TEST_PATH).expect(202)).body, { queued: 2 })
    await built.lms.pushDispatcher.whenIdle()

    assert.deepEqual(built.push.requests.map((r) => r.url).sort(), mine.map((s) => s.endpoint).sort())
    assert.equal(built.push.payloadOf(built.push.to(mine[0].endpoint)[0], mine[0]).kind, 'test')

    // 운영 설정: 라우트 자체가 없어 로그인 확인보다 먼저 404(개발 설정에서는 같은 요청이 401)
    const prod = buildPushApp(ctx, { config: { ...ctx.config, isProduction: true } })
    assert.equal((await request(prod.app).post(PUSH_TEST_PATH).expect(404)).body.error, 'not_found')
    await request(built.app).post(PUSH_TEST_PATH).expect(401)
  })

  it('푸시 설정 없이 만든 앱(기존 테스트 기본값): 라우트는 있지만 503 push_unavailable', async () => {
    const app = ctx.buildApp(createFakeKakaoClient())
    assert.equal((await request(app).get(PUBLIC_KEY_PATH).expect(503)).body.error, 'push_unavailable')
  })
})
