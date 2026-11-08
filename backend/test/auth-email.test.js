import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'
import { createRacingUserRepository } from './helpers/racing-user-repository.js'
import { sessionCookieFrom } from './helpers/auth-flow.js'
import { readOurSessionData } from './helpers/session-data.js'
import { signup, emailLogin, createCountingHasher, VALID_EMAIL, VALID_PASSWORD, SIGNUP_PATH, LOGIN_PATH } from './helpers/email-flow.js'
import { createPasswordHasher } from '../src/email/password-hasher.js'

const INVALID_CREDENTIALS = { error: 'invalid_credentials', message: '이메일 또는 비밀번호가 올바르지 않습니다.' }

describe('이메일 가입 · 로그인', () => {
  let ctx
  let hasher
  let app

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    hasher = createCountingHasher(createPasswordHasher())
    app = ctx.buildApp(createFakeKakaoClient(), { passwordHasher: hasher })
  })
  after(async () => {
    await ctx.close()
  })

  it('1. 정상 가입 → 201, users · auth_identities(email) · password_credentials 각 1행, 세션 발급, lms_token', async () => {
    const agent = request.agent(app)

    const res = await signup(agent, { email: VALID_EMAIL, password: VALID_PASSWORD, displayName: '  이메일사용자 ' }).expect(201)

    const [[user]] = await ctx.pool.query('SELECT id, display_name, onboarding_step FROM users')
    assert.deepEqual(res.body, { id: user.id, displayName: '이메일사용자', onboardingStep: 'lms_token' })
    for (const table of ['users', 'auth_identities', 'password_credentials']) {
      assert.equal(await ctx.countRows(table), 1, table)
    }
    const [[identity]] = await ctx.pool.query('SELECT provider, provider_user_id FROM auth_identities')
    assert.deepEqual({ ...identity }, { provider: 'email', provider_user_id: VALID_EMAIL })
    assert.deepEqual(await readOurSessionData(ctx.pool, sessionCookieFrom(res)), { userId: user.id })
    await agent.get('/api/auth/me').expect(200)
  })

  it('가입 시 displayName이 없으면 "사용자"', async () => {
    const res = await signup(request.agent(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)

    assert.equal(res.body.displayName, '사용자')
  })

  it('2. 가입 → 로그아웃 → 같은 이메일 · 비밀번호로 로그인 성공 (200, 같은 사용자)', async () => {
    const agent = request.agent(app)
    const { body: created } = await signup(agent, { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)
    await agent.post('/api/auth/logout').expect(204)
    await agent.get('/api/auth/me').expect(401)

    const res = await emailLogin(agent, { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(200)

    assert.deepEqual(res.body, created)
    assert.equal((await agent.get('/api/auth/me').expect(200)).body.id, created.id)
  })

  it('3. 대소문자 · 공백만 다른 이메일로 로그인 → 같은 계정', async () => {
    const { body: created } = await signup(request.agent(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)

    const res = await emailLogin(request.agent(app), { email: '  USER@Example.COM ', password: VALID_PASSWORD }).expect(200)

    assert.equal(res.body.id, created.id)
  })

  it('4. 중복 이메일 가입(대소문자만 다름) → 409 email_already_registered, 행 추가 없음, 세션 없음', async () => {
    await signup(request.agent(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)
    const agent = request.agent(app)

    const res = await signup(agent, { email: 'User@Example.com', password: 'another password 123' }).expect(409)

    assert.equal(res.body.error, 'email_already_registered')
    for (const table of ['users', 'auth_identities', 'password_credentials']) {
      assert.equal(await ctx.countRows(table), 1, table)
    }
    await agent.get('/api/auth/me').expect(401)
  })

  it('5. 같은 이메일 가입 동시 2개 → 계정 1개, 한쪽 201 · 한쪽 409, 중복 처리 정확히 1번', async () => {
    const userRepository = createRacingUserRepository(ctx.pool, { logger: ctx.silentLogger })
    const racingApp = ctx.buildApp(createFakeKakaoClient(), { userRepository })
    const body = { email: VALID_EMAIL, password: VALID_PASSWORD }

    const responses = await Promise.all([signup(request(racingApp), body), signup(request(racingApp), body)])

    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409])
    assert.equal(userRepository.stats.duplicateErrors, 1)
    for (const table of ['users', 'auth_identities', 'password_credentials']) {
      assert.equal(await ctx.countRows(table), 1, `${table}: 진 쪽 트랜잭션이 롤백돼야 함`)
    }
  })

  it('6. 틀린 비밀번호 / 없는 이메일 → 같은 401 코드 · 메시지, 해시 비교는 각각 정확히 1번', async () => {
    await signup(request.agent(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)
    const results = []
    for (const body of [
      { email: VALID_EMAIL, password: 'wrong password!' },
      { email: 'nobody@example.com', password: VALID_PASSWORD },
    ]) {
      const before = hasher.calls.verify
      const res = await emailLogin(request.agent(app), body).expect(401)
      results.push({ body: res.body, verifyCalls: hasher.calls.verify - before, cookie: sessionCookieFrom(res) })
    }

    for (const result of results) {
      assert.deepEqual(result.body, INVALID_CREDENTIALS)
      assert.equal(result.verifyCalls, 1, '없는 이메일에도 해시 비교를 한 번 해야 함')
      assert.equal(result.cookie, null, '실패하면 세션을 발급하지 않음')
    }
  })

  it('소셜로 가입한 계정은 이메일 로그인으로 들어올 수 없다 (provider_user_id 값이 같아도)', async () => {
    const [user] = await ctx.pool.execute('INSERT INTO users (display_name) VALUES (?)', ['소셜'])
    await ctx.pool.execute('INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, ?, ?)', [
      user.insertId,
      'kakao',
      VALID_EMAIL,
    ])

    const res = await emailLogin(request.agent(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(401)

    assert.deepEqual(res.body, INVALID_CREDENTIALS)
  })

  it('로그인 성공 시 세션 ID를 새로 발급한다 (로그인 전 세션 쿠키로는 인증 안 됨)', async () => {
    await signup(request.agent(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)
    const agent = request.agent(app)
    const kakaoStart = await agent.get('/api/auth/kakao').expect(302)
    const before = sessionCookieFrom(kakaoStart)

    const res = await emailLogin(agent, { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(200)

    const after = sessionCookieFrom(res)
    assert.ok(before && after && before !== after)
    await request(app).get('/api/auth/me').set('Cookie', before).expect(401)
  })

  it('9. DB에는 원문이 아니라 argon2id 해시가 저장된다', async () => {
    await signup(request.agent(app), { email: VALID_EMAIL, password: VALID_PASSWORD }).expect(201)

    const [[row]] = await ctx.pool.query('SELECT password_hash, email_verified FROM password_credentials')
    assert.match(row.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    assert.ok(!row.password_hash.includes(VALID_PASSWORD))
    assert.equal(row.email_verified, 0)
  })

  describe('8. 검증 실패 → 400 + 항목별 에러 코드 · field', () => {
    const cases = [
      ['잘못된 이메일 형식', { email: 'not-an-email', password: VALID_PASSWORD }, 'invalid_email', 'email'],
      ['비밀번호 7자', { email: VALID_EMAIL, password: '1234567' }, 'password_too_short', 'password'],
      ['비밀번호 129자', { email: VALID_EMAIL, password: 'a'.repeat(129) }, 'password_too_long', 'password'],
      ['이메일 빈 값', { email: '', password: VALID_PASSWORD }, 'missing_email', 'email'],
      ['비밀번호 빈 값', { email: VALID_EMAIL, password: '' }, 'missing_password', 'password'],
    ]
    for (const [label, body, code, field] of cases) {
      it(`가입: ${label} → ${code}`, async () => {
        const res = await signup(request.agent(app), body).expect(400)

        assert.equal(res.body.error, code)
        assert.equal(res.body.field, field)
        assert.ok(res.body.message)
        assert.equal(await ctx.countRows('users'), 0)
      })
    }

    it('로그인: 잘못된 이메일 형식 → 400 invalid_email (field: email), 해시 비교 안 함', async () => {
      const res = await emailLogin(request.agent(app), { email: 'not-an-email', password: VALID_PASSWORD }).expect(400)

      assert.deepEqual({ error: res.body.error, field: res.body.field }, { error: 'invalid_email', field: 'email' })
      assert.equal(hasher.calls.verify, 0)
    })
  })

  describe('11. JSON이 아닌 요청 거부', () => {
    for (const path of [SIGNUP_PATH, LOGIN_PATH]) {
      it(`${path}: form(urlencoded) → 415 unsupported_media_type, 계정 생성 · 해시 비교 없음`, async () => {
        const res = await request(app)
          .post(path)
          .type('form')
          .send({ email: VALID_EMAIL, password: VALID_PASSWORD })
          .expect(415)

        assert.equal(res.body.error, 'unsupported_media_type')
        assert.equal(await ctx.countRows('users'), 0)
        assert.equal(hasher.calls.hash + hasher.calls.verify, 0)
      })

      it(`${path}: text/plain → 415`, async () => {
        await request(app).post(path).set('Content-Type', 'text/plain').send('email=x').expect(415)
      })
    }

    it('깨진 JSON → 400 invalid_json', async () => {
      const res = await request(app).post(LOGIN_PATH).set('Content-Type', 'application/json').send('{"email": ').expect(400)

      assert.equal(res.body.error, 'invalid_json')
    })
  })
})
