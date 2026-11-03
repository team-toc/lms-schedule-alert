import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext, FRONTEND_URL } from './helpers/test-context.js'
import { createFakeKakaoClient, createBarrier, DEFAULT_PROFILE, FAKE_AUTHORIZE_URL } from './helpers/fake-kakao-client.js'
import { startLogin, callback, login, sessionCookieFrom } from './helpers/auth-flow.js'

describe('카카오 로그인 콜백', () => {
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

  it('로그인 시작 시 state를 담아 카카오 인가 페이지로 보낸다', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient()))

    const { res, state } = await startLogin(agent)

    assert.ok(res.headers.location.startsWith(FAKE_AUTHORIZE_URL))
    assert.ok(state.length >= 32, 'state는 추측하기 어려운 길이여야 함')
  })

  it('1. 처음 로그인한 카카오 사용자 → users · auth_identities 각 1행, onboarding_step = lms_token', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient()))

    const { res } = await login(agent)

    assert.equal(res.headers.location, FRONTEND_URL)
    assert.equal(await ctx.countRows('users'), 1)
    assert.equal(await ctx.countRows('auth_identities'), 1)
    const [[user]] = await ctx.pool.query('SELECT display_name, onboarding_step FROM users')
    assert.equal(user.display_name, DEFAULT_PROFILE.nickname)
    assert.equal(user.onboarding_step, 'lms_token')
    const [[identity]] = await ctx.pool.query('SELECT provider, provider_user_id FROM auth_identities')
    assert.deepEqual({ ...identity }, { provider: 'kakao', provider_user_id: DEFAULT_PROFILE.id })
  })

  it('2. 같은 카카오 계정으로 재로그인 → 새 계정 없이 기존 계정으로 로그인', async () => {
    const app = ctx.buildApp(createFakeKakaoClient())
    const first = request.agent(app)
    const second = request.agent(app)

    await login(first)
    const [[existing]] = await ctx.pool.query('SELECT id FROM users')
    await login(second)

    assert.equal(await ctx.countRows('users'), 1)
    assert.equal(await ctx.countRows('auth_identities'), 1)
    const me = await second.get('/api/auth/me').expect(200)
    assert.equal(me.body.id, existing.id)
  })

  it('3. 같은 카카오 계정 콜백 2개 동시 실행 → 계정 1개만 생성', async () => {
    const app = ctx.buildApp(createFakeKakaoClient({ beforeProfile: createBarrier(2) }))
    const agents = [request.agent(app), request.agent(app)]
    const states = await Promise.all(agents.map(async (agent) => (await startLogin(agent)).state))

    const responses = await Promise.all(agents.map((agent, i) => callback(agent, { state: states[i] })))

    for (const res of responses) {
      assert.equal(res.status, 302)
      assert.equal(res.headers.location, FRONTEND_URL)
    }
    assert.equal(await ctx.countRows('users'), 1)
    assert.equal(await ctx.countRows('auth_identities'), 1)
    const ids = await Promise.all(agents.map(async (agent) => (await agent.get('/api/auth/me').expect(200)).body.id))
    assert.equal(ids[0], ids[1])
  })

  it('4. state 불일치 → 400 invalid_state, 계정 생성 안 됨, 카카오 호출 안 함', async () => {
    const kakao = createFakeKakaoClient()
    const agent = request.agent(ctx.buildApp(kakao))
    await startLogin(agent)

    const res = await callback(agent, { state: 'forged-state' }).expect(400)

    assert.equal(res.body.error, 'invalid_state')
    assert.ok(res.body.message)
    assert.equal(kakao.calls.exchange.length, 0)
    assert.equal(await ctx.countRows('users'), 0)
    await agent.get('/api/auth/me').expect(401)
  })

  it('4-1. 로그인 시작 없이 콜백만 호출(세션에 state 없음) → 400 invalid_state', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient()))

    const res = await callback(agent, { state: 'any-state' }).expect(400)

    assert.equal(res.body.error, 'invalid_state')
    assert.equal(await ctx.countRows('users'), 0)
  })

  it('4-2. 이미 쓴 state로 다시 콜백 → 400 invalid_state (재사용 불가)', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient()))
    const { state } = await startLogin(agent)
    await callback(agent, { state }).expect(302)

    const res = await callback(agent, { state }).expect(400)

    assert.equal(res.body.error, 'invalid_state')
  })

  it('5. 카카오 토큰 교환 실패 → 502 kakao_api_failed, 세션 발급 안 됨', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient({ failAt: 'token' })))
    const { state } = await startLogin(agent)

    const res = await callback(agent, { state }).expect(502)

    assert.equal(res.body.error, 'kakao_api_failed')
    assert.ok(res.body.message)
    assert.equal(res.body.stack, undefined)
    assert.equal(await ctx.countRows('users'), 0)
    await agent.get('/api/auth/me').expect(401)
  })

  it('5-1. 카카오 사용자 조회 실패 → 502 kakao_api_failed, 계정 생성 안 됨', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient({ failAt: 'profile' })))
    const { state } = await startLogin(agent)

    const res = await callback(agent, { state }).expect(502)

    assert.equal(res.body.error, 'kakao_api_failed')
    assert.equal(await ctx.countRows('users'), 0)
  })

  it('사용자가 카카오 동의 화면에서 취소 → 400 kakao_login_denied, 토큰 교환 안 함', async () => {
    const kakao = createFakeKakaoClient()
    const agent = request.agent(ctx.buildApp(kakao))
    const { state } = await startLogin(agent)

    const res = await agent.get('/api/auth/kakao/callback').query({ error: 'access_denied', state }).expect(400)

    assert.equal(res.body.error, 'kakao_login_denied')
    assert.equal(kakao.calls.exchange.length, 0)
  })

  it('로그인 성공 시 세션 ID를 새로 발급하고, 로그인 전 쿠키로는 인증되지 않는다', async () => {
    const app = ctx.buildApp(createFakeKakaoClient())
    const agent = request.agent(app)
    const { res: startRes, state } = await startLogin(agent)
    const cookieBeforeLogin = sessionCookieFrom(startRes)

    const loginRes = await callback(agent, { state }).expect(302)
    const cookieAfterLogin = sessionCookieFrom(loginRes)

    assert.ok(cookieBeforeLogin && cookieAfterLogin)
    assert.notEqual(cookieAfterLogin, cookieBeforeLogin)
    await request(app).get('/api/auth/me').set('Cookie', cookieBeforeLogin).expect(401)
    await request(app).get('/api/auth/me').set('Cookie', cookieAfterLogin).expect(200)
  })

  it('세션 쿠키는 httpOnly · SameSite=Lax 이다', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient()))

    const { res } = await login(agent)

    const raw = res.headers['set-cookie'].find((c) => c.startsWith('sid='))
    assert.match(raw, /HttpOnly/i)
    assert.match(raw, /SameSite=Lax/i)
  })
})
