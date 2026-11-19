import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createPushSender, PUSH_TTL_SECONDS, PUSH_TIMEOUT_MS } from '../src/push/push-sender.js'
import { createFakePushService, makeSubscription, decryptPushBody, timeoutError, TEST_PUSH_CONFIG } from './helpers/push-context.js'

const VAPID = { publicKey: TEST_PUSH_CONFIG.vapidPublicKey, privateKey: TEST_PUSH_CONFIG.vapidPrivateKey, subject: TEST_PUSH_CONFIG.vapidSubject }
const PAYLOAD = JSON.stringify({ v: 1, notificationId: 31, kind: 'assignment_due_changed', title: '마감 변경', body: '자료구조 · 과제 1', url: '/?view=notifications' })
const target = (s) => ({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth })
const jwtClaims = (authorization) => JSON.parse(Buffer.from(authorization.match(/^vapid t=([^,]+),/)[1].split('.')[1], 'base64url').toString('utf8'))

// 결과에 endpoint · 키가 없어야 한다
function assertResult(result, expected, subscription) {
  assert.deepEqual(result, expected)
  const text = JSON.stringify(result)
  for (const secret of [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]) {
    assert.ok(!text.includes(secret), '결과에 구독 값이 있으면 안 됨')
  }
}

// 발송기 (경계 레이어, ADR 0012): web-push로 암호화 본문 · VAPID 헤더만 만들고 보내기는 주입한 fetch로. 던지지 않고 결과 코드로
describe('푸시 발송기', () => {
  let push
  let sender
  let sub

  beforeEach(() => {
    push = createFakePushService()
    sender = createPushSender({ fetchFn: push.fetch, vapid: VAPID })
    sub = makeSubscription()
  })

  it('201 → sent. 요청: endpoint로 POST, TTL 1일 · aes128gcm · VAPID(t=JWT, k=공개키) · Topic, Urgency 없음, 리다이렉트 manual, 타임아웃 신호', async () => {
    assertResult(await sender.send(target(sub), PAYLOAD, { topic: 'n31' }), { outcome: 'sent', code: null }, sub)

    const [req] = push.requests
    assert.equal(req.url, sub.endpoint)
    assert.equal(req.init.method, 'POST')
    assert.equal(req.headers.get('ttl'), String(PUSH_TTL_SECONDS))
    assert.equal(PUSH_TTL_SECONDS, 86400)
    assert.equal(req.headers.get('content-encoding'), 'aes128gcm')
    assert.equal(req.headers.get('topic'), 'n31')
    assert.equal(req.headers.get('urgency'), null, 'Safari BadUrgency 때문에 보내지 않음')
    assert.match(req.headers.get('authorization'), new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${VAPID.publicKey}$`))
    assert.ok(!req.headers.has('cookie'))
    assert.equal(req.init.redirect, 'manual')
    assert.ok(req.init.signal instanceof AbortSignal)
  })

  it('본문은 그 브라우저 키로만 풀린다(RFC 8291): 풀면 보낸 payload 그대로, 다른 구독 키로는 안 풀림', async () => {
    const other = makeSubscription()
    await sender.send(target(sub), PAYLOAD, { topic: 'n31' })

    assert.equal(decryptPushBody(push.requests[0].body, sub.browser), PAYLOAD)
    assert.throws(() => decryptPushBody(push.requests[0].body, other.browser))
    assert.ok(!push.requests[0].body.includes(Buffer.from('자료구조')), '평문이 본문에 그대로 있으면 안 됨')
  })

  it('VAPID JWT: aud = 푸시 서비스 출처, sub = 연락처, exp는 24시간 이내', async () => {
    await sender.send(target(sub), PAYLOAD, { topic: 'n31' })

    const claims = jwtClaims(push.requests[0].headers.get('authorization'))
    assert.equal(claims.aud, 'https://fcm.googleapis.com')
    assert.equal(claims.sub, VAPID.subject)
    const left = claims.exp - Math.floor(Date.now() / 1000)
    assert.ok(left > 0 && left <= 24 * 60 * 60, `exp까지 ${left}초`)
  })

  it('응답 코드: 404 · 410 → expired, 429 · 5xx · 그 밖의 4xx → failed(http_상태), 리다이렉트는 따라가지 않고 failed(redirect)', async () => {
    const cases = [
      [404, { outcome: 'expired', code: 'http_404' }],
      [410, { outcome: 'expired', code: 'http_410' }],
      [429, { outcome: 'failed', code: 'http_429' }],
      [500, { outcome: 'failed', code: 'http_500' }],
      [503, { outcome: 'failed', code: 'http_503' }],
      [400, { outcome: 'failed', code: 'http_400' }],
      [403, { outcome: 'failed', code: 'http_403' }],
      [413, { outcome: 'failed', code: 'http_413' }],
      [() => new Response(null, { status: 301, headers: { Location: 'https://evil.example/' } }), { outcome: 'failed', code: 'redirect' }],
    ]
    for (const [rule, expected] of cases) {
      push.respond(sub.endpoint, rule)
      assertResult(await sender.send(target(sub), PAYLOAD, { topic: 'n31' }), expected, sub)
    }
    assert.equal(push.requests.length, cases.length, '리다이렉트를 따라간 요청 없음')
  })

  it('타임아웃(fetch가 TimeoutError) → failed(timeout), 네트워크 오류 · 그 밖의 예외 → failed(network), 던지지 않는다', async () => {
    for (const [rule, code] of [
      [() => Promise.reject(timeoutError()), 'timeout'],
      [() => Promise.reject(new TypeError('fetch failed')), 'network'],
      [() => Promise.reject(new Error(`boom ${sub.endpoint}`)), 'network'],
    ]) {
      push.respond(sub.endpoint, rule)
      assertResult(await sender.send(target(sub), PAYLOAD, { topic: 'n31' }), { outcome: 'failed', code }, sub)
    }
  })

  it('보내기 직전 endpoint를 다시 검사: 허용 목록 밖 · http면 요청하지 않고 failed(endpoint_not_allowed)', async () => {
    for (const endpoint of ['https://evil.example/x', 'http://fcm.googleapis.com/fcm/send/x', 'https://127.0.0.1/x']) {
      assert.deepEqual(await sender.send({ ...target(sub), endpoint }, PAYLOAD, { topic: 'n31' }), { outcome: 'failed', code: 'endpoint_not_allowed' })
    }
    assert.equal(push.requests.length, 0)
  })

  it('payload가 RFC 8291 평문 상한(3993바이트)을 넘으면 보내지 않고 failed(payload_too_large)', async () => {
    assert.deepEqual(await sender.send(target(sub), 'x'.repeat(3994), { topic: 'n31' }), { outcome: 'failed', code: 'payload_too_large' })
    assert.equal(push.requests.length, 0)
  })

  it('타임아웃 신호: 기본은 AbortSignal.timeout(5초), 바꿔 끼운 함수는 timeoutMs로 불리고 그 신호가 요청에 붙는다', async () => {
    const realTimeout = AbortSignal.timeout
    const made = []
    AbortSignal.timeout = (ms) => {
      const signal = realTimeout.call(AbortSignal, ms)
      made.push({ ms, signal })
      return signal
    }
    try {
      await sender.send(target(sub), PAYLOAD, { topic: 'n31' })
    } finally {
      AbortSignal.timeout = realTimeout
    }
    assert.equal(PUSH_TIMEOUT_MS, 5000)
    assert.deepEqual(made.map((m) => m.ms), [PUSH_TIMEOUT_MS])
    assert.equal(push.requests[0].init.signal, made[0].signal)

    const controller = new AbortController()
    const calls = []
    const injected = createPushSender({ fetchFn: push.fetch, vapid: VAPID, timeoutMs: 1234, createTimeoutSignal: (ms) => (calls.push(ms), controller.signal) })
    await injected.send(target(sub), PAYLOAD, { topic: 'n31' })
    assert.deepEqual(calls, [1234])
    assert.equal(push.requests.at(-1).init.signal, controller.signal)
  })
})
