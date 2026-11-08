import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'
import { signup, emailLogin, createFakeClock, VALID_EMAIL, VALID_PASSWORD, MINUTE_MS } from './helpers/email-flow.js'
import { createLoginThrottle } from '../src/auth/login-throttle.js'

const MAX_FAILURES = 5
const LOCK_MINUTES = 15
const LOCK_MS = LOCK_MINUTES * MINUTE_MS
const WRONG = { email: VALID_EMAIL, password: 'wrong password!' }
const RIGHT = { email: VALID_EMAIL, password: VALID_PASSWORD }

describe('7. 이메일 로그인 실패 횟수 제한', () => {
  let ctx
  let clock

  function buildApp({ trustProxy = false } = {}) {
    const loginThrottle = createLoginThrottle({
      maxFailures: MAX_FAILURES,
      lockMs: LOCK_MS,
      maxEntries: 1000,
      now: clock.now,
      logger: ctx.silentLogger,
    })
    return ctx.buildApp(createFakeKakaoClient(), { loginThrottle, config: { ...ctx.config, trustProxy } })
  }

  async function failFrom(app, times, { body = WRONG, forwardedFor } = {}) {
    for (let i = 0; i < times; i += 1) {
      const req = emailLogin(request(app), body)
      await (forwardedFor ? req.set('X-Forwarded-For', forwardedFor) : req).expect(401)
    }
  }

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    clock = createFakeClock()
  })
  after(async () => {
    await ctx.close()
  })

  it('5번 실패 → 429 too_many_attempts + Retry-After(900초), 맞는 비밀번호도 잠긴 동안 429', async () => {
    const app = buildApp()
    await signup(request(app), RIGHT).expect(201)
    await failFrom(app, MAX_FAILURES)

    const locked = await emailLogin(request(app), WRONG).expect(429)
    const lockedRight = await emailLogin(request(app), RIGHT).expect(429)

    assert.equal(locked.body.error, 'too_many_attempts')
    assert.equal(locked.headers['retry-after'], String(LOCK_MINUTES * 60))
    assert.equal(lockedRight.body.error, 'too_many_attempts', '잠긴 동안은 비밀번호가 맞는지도 알려 주지 않음')
  })

  it('Retry-After는 주입한 시계 기준 남은 시간, 잠금 시간이 지나면 다시 로그인 가능', async () => {
    const app = buildApp()
    await signup(request(app), RIGHT).expect(201)
    await failFrom(app, MAX_FAILURES)

    clock.advance(LOCK_MS - MINUTE_MS)
    const almost = await emailLogin(request(app), RIGHT).expect(429)
    assert.equal(almost.headers['retry-after'], '60')

    clock.advance(MINUTE_MS)
    await emailLogin(request(app), RIGHT).expect(200)
  })

  it('로그인 성공 시 실패 횟수 초기화: 4번 실패 → 성공 → 4번 실패해도 잠기지 않음', async () => {
    const app = buildApp()
    await signup(request(app), RIGHT).expect(201)
    await failFrom(app, MAX_FAILURES - 1)
    await emailLogin(request(app), RIGHT).expect(200)

    await failFrom(app, MAX_FAILURES - 1)

    await emailLogin(request(app), RIGHT).expect(200)
  })

  it('c) 없는 이메일로 실패해도 횟수에 포함 → 같은 429 (존재 여부가 드러나지 않음)', async () => {
    const app = buildApp()
    const nobody = { email: 'nobody@example.com', password: 'whatever pw' }
    await failFrom(app, MAX_FAILURES, { body: nobody })

    const res = await emailLogin(request(app), nobody).expect(429)

    assert.equal(res.body.error, 'too_many_attempts')
  })

  it('a) 프록시 신뢰가 켜지면 X-Forwarded-For가 다른 두 IP는 서로 다른 카운터 (3번씩 실패해도 안 잠김)', async () => {
    const app = buildApp({ trustProxy: true })
    await signup(request(app), RIGHT).expect(201)

    await failFrom(app, 3, { forwardedFor: '203.0.113.1' })
    await failFrom(app, 3, { forwardedFor: '198.51.100.7' })

    await emailLogin(request(app), WRONG).set('X-Forwarded-For', '203.0.113.1').expect(401)
    await emailLogin(request(app), WRONG).set('X-Forwarded-For', '198.51.100.7').expect(401)
  })

  it('b) 같은 이메일이라도 IP가 다르면 한쪽 잠금이 다른 쪽에 영향 없음', async () => {
    const app = buildApp({ trustProxy: true })
    await signup(request(app), RIGHT).expect(201)
    await failFrom(app, MAX_FAILURES, { forwardedFor: '203.0.113.1' })

    await emailLogin(request(app), RIGHT).set('X-Forwarded-For', '203.0.113.1').expect(429)

    await emailLogin(request(app), RIGHT).set('X-Forwarded-For', '198.51.100.7').expect(200)
  })

  it('프록시 신뢰가 꺼져 있으면 X-Forwarded-For를 믿지 않는다 (헤더를 바꿔도 같은 카운터)', async () => {
    const app = buildApp({ trustProxy: false })
    await signup(request(app), RIGHT).expect(201)
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await emailLogin(request(app), WRONG).set('X-Forwarded-For', `203.0.113.${i + 1}`).expect(401)
    }

    await emailLogin(request(app), RIGHT).set('X-Forwarded-For', '198.51.100.7').expect(429)
  })

  it('가입은 실패 횟수 제한 대상이 아니다', async () => {
    const app = buildApp()
    await failFrom(app, MAX_FAILURES)

    await signup(request(app), RIGHT).expect(201)
  })
})
