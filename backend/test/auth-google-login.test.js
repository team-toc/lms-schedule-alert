import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext, FRONTEND_URL, GOOGLE_TEST_CONFIG } from './helpers/test-context.js'
import { createFakeKakaoClient, DEFAULT_PROFILE } from './helpers/fake-kakao-client.js'
import { createFakeGoogleTokenEndpoint, idTokenClaims, DEFAULT_GOOGLE_SUB, DEFAULT_GOOGLE_NAME } from './helpers/fake-google.js'
import { createRacingUserRepository } from './helpers/racing-user-repository.js'
import { startLogin, callback, login, sessionCookieFrom, assertLoginErrorRedirect } from './helpers/auth-flow.js'
import { startGoogleLogin, googleCallback, googleLogin } from './helpers/google-flow.js'
import { createGoogleClient } from '../src/google/google-client.js'

describe('Google 로그인 콜백', () => {
  let ctx
  let endpoint
  let kakao
  let app

  function buildGoogleApp(overrides = {}) {
    const googleClient = createGoogleClient({ config: GOOGLE_TEST_CONFIG, fetchFn: endpoint.fetchFn })
    return ctx.buildApp(kakao, { googleClient, ...overrides })
  }

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    endpoint = createFakeGoogleTokenEndpoint()
    kakao = createFakeKakaoClient()
    app = buildGoogleApp()
  })
  after(async () => {
    await ctx.close()
  })

  it('로그인 시작: state · nonce를 담아 Google 인가 페이지로 보낸다', async () => {
    const { location, state, nonce } = await startGoogleLogin(request.agent(app))

    assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
    assert.ok(state.length >= 32 && nonce.length >= 32, 'state · nonce는 추측하기 어려운 길이')
    assert.notEqual(state, nonce)
  })

  it("1. 첫 로그인 → users · auth_identities(provider='google') 각 1행, onboarding_step = lms_token", async () => {
    const { res } = await googleLogin(request.agent(app), endpoint)

    assert.equal(res.headers.location, FRONTEND_URL)
    assert.equal(await ctx.countRows('users'), 1)
    assert.equal(await ctx.countRows('auth_identities'), 1)
    const [[user]] = await ctx.pool.query('SELECT display_name, onboarding_step FROM users')
    assert.deepEqual({ ...user }, { display_name: DEFAULT_GOOGLE_NAME, onboarding_step: 'lms_token' })
    const [[identity]] = await ctx.pool.query('SELECT provider, provider_user_id FROM auth_identities')
    assert.deepEqual({ ...identity }, { provider: 'google', provider_user_id: DEFAULT_GOOGLE_SUB })
  })

  it('2. 같은 Google 계정 재로그인 → 기존 계정, 새 행 없음, display_name 유지', async () => {
    const first = request.agent(app)
    await googleLogin(first, endpoint)
    const [[existing]] = await ctx.pool.query('SELECT id FROM users')
    const second = request.agent(app)

    await googleLogin(second, endpoint, { code: 'second-code', claims: { name: '바뀐이름' } })

    assert.equal(await ctx.countRows('users'), 1)
    assert.equal(await ctx.countRows('auth_identities'), 1)
    const me = await second.get('/api/auth/me').expect(200)
    assert.deepEqual(me.body, { id: existing.id, displayName: DEFAULT_GOOGLE_NAME, onboardingStep: 'lms_token' })
  })

  it('3. 같은 계정 콜백 동시 2개 → 계정 1개, 중복 처리 경로 정확히 1번', async () => {
    const userRepository = createRacingUserRepository(ctx.pool, { logger: ctx.silentLogger })
    const racingApp = buildGoogleApp({ userRepository })
    const agents = [request.agent(racingApp), request.agent(racingApp)]
    const starts = await Promise.all(agents.map((agent) => startGoogleLogin(agent)))
    starts.forEach(({ nonce }, i) => endpoint.issueIdToken(`race-code-${i}`, idTokenClaims({ nonce })))

    const responses = await Promise.all(
      agents.map((agent, i) => googleCallback(agent, { code: `race-code-${i}`, state: starts[i].state })),
    )

    assert.equal(userRepository.stats.duplicateErrors, 1, '두 요청 중 정확히 하나가 중복 키를 만나야 함')
    responses.forEach((res) => assert.equal(res.headers.location, FRONTEND_URL))
    assert.equal(await ctx.countRows('users'), 1)
    assert.equal(await ctx.countRows('auth_identities'), 1)
    const ids = await Promise.all(agents.map(async (agent) => (await agent.get('/api/auth/me').expect(200)).body.id))
    assert.equal(ids[0], ids[1])
  })

  it('4. state 불일치 → invalid_state, 계정 생성 · 토큰 요청 안 함', async () => {
    const agent = request.agent(app)
    await startGoogleLogin(agent)

    assertLoginErrorRedirect(await googleCallback(agent, { state: 'forged-state' }), 'invalid_state')
    assert.equal(endpoint.requests.length, 0)
    assert.equal(await ctx.countRows('users'), 0)
    await agent.get('/api/auth/me').expect(401)
  })

  it('4-1. 로그인 시작 없이 콜백(세션에 state 없음) → invalid_state', async () => {
    assertLoginErrorRedirect(await googleCallback(request.agent(app), { state: 'any-state' }), 'invalid_state')
    assert.equal(endpoint.requests.length, 0)
  })

  it('4-2. 이미 쓴 state로 다시 콜백 → invalid_state (재사용 불가)', async () => {
    const agent = request.agent(app)
    const { state } = await googleLogin(agent, endpoint)

    assertLoginErrorRedirect(await googleCallback(agent, { state }), 'invalid_state')
    assert.equal(endpoint.requests.length, 1)
  })

  it('nonce 재사용 거부: 이전 로그인의 nonce가 든 id_token을 다음 로그인에 쓰면 google_api_failed', async () => {
    const agent = request.agent(app)
    const { nonce: usedNonce } = await googleLogin(agent, endpoint)
    const { state } = await startGoogleLogin(agent)
    endpoint.issueIdToken('replay-code', idTokenClaims({ nonce: usedNonce }))

    assertLoginErrorRedirect(await googleCallback(agent, { code: 'replay-code', state }), 'google_api_failed')
  })

  it('5. 동의 취소(error=access_denied) → google_login_denied, 토큰 요청 안 함', async () => {
    const agent = request.agent(app)
    const { state } = await startGoogleLogin(agent)

    const res = await agent.get('/api/auth/google/callback').query({ error: 'access_denied', state })

    assertLoginErrorRedirect(res, 'google_login_denied')
    assert.equal(endpoint.requests.length, 0)
  })

  it('카카오 로그인으로 저장된 state를 Google 콜백에 보내면 invalid_state', async () => {
    const agent = request.agent(app)
    const { state: kakaoState } = await startLogin(agent)

    assertLoginErrorRedirect(await googleCallback(agent, { state: kakaoState }), 'invalid_state')
    assert.equal(endpoint.requests.length, 0)
  })

  it('Google 로그인으로 저장된 state를 카카오 콜백에 보내면 invalid_state', async () => {
    const agent = request.agent(app)
    const { state: googleState } = await startGoogleLogin(agent)

    assertLoginErrorRedirect(await callback(agent, { state: googleState }), 'invalid_state')
    assert.equal(kakao.calls.exchange.length, 0)
  })

  it('9. 같은 provider_user_id 값이 kakao · google에 있어도 서로 다른 계정', async () => {
    const kakaoAgent = request.agent(app)
    const googleAgent = request.agent(app)
    await login(kakaoAgent)

    await googleLogin(googleAgent, endpoint, { claims: { sub: DEFAULT_PROFILE.id } })

    assert.equal(await ctx.countRows('users'), 2)
    const [rows] = await ctx.pool.query('SELECT provider, provider_user_id FROM auth_identities ORDER BY provider')
    assert.deepEqual(rows.map((r) => [r.provider, r.provider_user_id]), [
      ['kakao', DEFAULT_PROFILE.id],
      ['google', DEFAULT_PROFILE.id],
    ])
    const kakaoMe = await kakaoAgent.get('/api/auth/me').expect(200)
    const googleMe = await googleAgent.get('/api/auth/me').expect(200)
    assert.notEqual(kakaoMe.body.id, googleMe.body.id)
  })

  it('로그인 성공 시 세션 ID를 새로 발급하고, 로그인 전 쿠키로는 인증되지 않는다', async () => {
    const agent = request.agent(app)
    const { res: startRes, state, nonce } = await startGoogleLogin(agent)
    endpoint.issueIdToken('code', idTokenClaims({ nonce }))

    const loginRes = await googleCallback(agent, { code: 'code', state }).expect(302)

    const before = sessionCookieFrom(startRes)
    const after = sessionCookieFrom(loginRes)
    assert.ok(before && after && before !== after)
    await request(app).get('/api/auth/me').set('Cookie', before).expect(401)
    await request(app).get('/api/auth/me').set('Cookie', after).expect(200)
  })

  it('Google로 로그인한 사용자도 공통 /api/auth/logout으로 로그아웃된다', async () => {
    const agent = request.agent(app)
    await googleLogin(agent, endpoint)

    await agent.post('/api/auth/logout').expect(204)

    await agent.get('/api/auth/me').expect(401)
  })
})
