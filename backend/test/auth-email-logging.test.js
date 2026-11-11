import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'
import { sessionCookieFrom, sessionIdFrom } from './helpers/auth-flow.js'
import { signup, emailLogin, VALID_EMAIL, VALID_PASSWORD } from './helpers/email-flow.js'

const MASKED_EMAIL = 'u***@example.com'

function createCapturingLogger() {
  const entries = []
  const logger = pino({ level: 'trace' }, { write: (line) => entries.push(JSON.parse(line)) })
  return { logger, entries, text: () => JSON.stringify(entries) }
}

describe('10. 이메일 로그인 로그에 민감 정보가 없다', () => {
  let ctx

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
  })
  after(async () => {
    await ctx.close()
  })

  it('가입 · 로그인 실패 · 성공 전체: 비밀번호 원문 · 해시 · 마스킹 안 된 이메일 · 세션 ID가 없다', async () => {
    const capture = createCapturingLogger()
    const app = ctx.buildApp(createFakeKakaoClient(), { logger: capture.logger })
    const signupRes = await signup(request(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)
    const failRes = await emailLogin(request(app), { email: VALID_EMAIL, password: 'wrong password!' }).expect(401)
    const loginRes = await emailLogin(request(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(200)
    const [[{ password_hash: passwordHash }]] = await ctx.pool.query('SELECT password_hash FROM password_credentials')

    const text = capture.text()
    const sessionIds = [signupRes, loginRes].map((res) => sessionIdFrom(sessionCookieFrom(res)))
    for (const secret of [VALID_PASSWORD, 'wrong password!', passwordHash, VALID_EMAIL, ...sessionIds]) {
      assert.ok(!text.includes(secret), '로그에 민감 정보가 있음')
    }
    assert.equal(sessionCookieFrom(failRes), null)
  })

  it('이벤트 로그는 남기되 이메일은 마스킹한다 (가입 · 실패 · 성공)', async () => {
    const capture = createCapturingLogger()
    const app = ctx.buildApp(createFakeKakaoClient(), { logger: capture.logger })
    await signup(request(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)
    await emailLogin(request(app), { email: VALID_EMAIL, password: 'wrong password!' }).expect(401)
    await emailLogin(request(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(200)

    const byEvent = (event) => capture.entries.filter((e) => e.event === event)
    for (const event of ['signup_succeeded', 'login_failed', 'login_succeeded']) {
      const [entry] = byEvent(event)
      assert.ok(entry, `${event} 로그가 있어야 함`)
      assert.equal(entry.provider, 'email')
      assert.equal(entry.email, MASKED_EMAIL)
    }
    assert.equal(byEvent('login_failed')[0].reason, 'invalid_credentials')
  })

  it('요청 본문 전체를 로그에 남기지 않는다 (검증 실패 · 중복 가입 포함)', async () => {
    const capture = createCapturingLogger()
    const app = ctx.buildApp(createFakeKakaoClient(), { logger: capture.logger })
    await signup(request(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)
    await signup(request(app), { email: VALID_EMAIL, password: 'dup password 123' }).expect(409)
    await signup(request(app), { email: VALID_EMAIL, password: 'Zq7#xY' }).expect(400)

    const text = capture.text()
    for (const secret of [VALID_PASSWORD, 'dup password 123', 'Zq7#xY', VALID_EMAIL]) {
      assert.ok(!text.includes(secret), '로그에 민감 정보가 있음')
    }
    assert.ok(!capture.entries.some((e) => e.body || e.req?.body), 'body 필드가 있으면 안 됨')
  })
})
