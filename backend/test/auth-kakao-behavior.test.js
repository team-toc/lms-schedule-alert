import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'
import { startLogin, callback, login, sessionCookieFrom, assertLoginErrorRedirect } from './helpers/auth-flow.js'
import { readOurSessionData } from './helpers/session-data.js'

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/

// 공통 OAuth 흐름으로 옮기기 전, 카카오 콜백의 현재 동작을 고정한다 (ADR 0006)
describe('카카오 콜백 현재 동작 고정', () => {
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

  it('로그인 시작 후 세션에는 oauthState 문자열 하나만 있다', async () => {
    const { res, state } = await startLogin(request.agent(ctx.buildApp(createFakeKakaoClient())))

    const data = await readOurSessionData(ctx.pool, sessionCookieFrom(res))

    assert.deepEqual(data, { oauthState: state })
    assert.match(state, BASE64URL_32_BYTES)
  })

  it('로그인 성공 후 새 세션에는 userId 하나만 있다 (state는 남지 않음)', async () => {
    const { cookie } = await login(request.agent(ctx.buildApp(createFakeKakaoClient())))
    const [[user]] = await ctx.pool.query('SELECT id FROM users')

    assert.deepEqual(await readOurSessionData(ctx.pool, cookie), { userId: user.id })
  })

  it('state는 맞지만 code가 없음 → invalid_request, 토큰 교환 안 함', async () => {
    const kakao = createFakeKakaoClient()
    const agent = request.agent(ctx.buildApp(kakao))
    const { state } = await startLogin(agent)

    assertLoginErrorRedirect(await agent.get('/api/auth/kakao/callback').query({ state }), 'invalid_request')
    assert.equal(kakao.calls.exchange.length, 0)
  })

  it('code가 빈 문자열 → invalid_request', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient()))
    const { state } = await startLogin(agent)

    assertLoginErrorRedirect(await callback(agent, { code: '', state }), 'invalid_request')
  })

  it('예상하지 못한 에러(카카오 API 에러가 아님) → server_error 리다이렉트, 계정 없음', async () => {
    const brokenKakao = {
      ...createFakeKakaoClient(),
      async exchangeCodeForToken() {
        throw new TypeError('unexpected bug')
      },
    }
    const agent = request.agent(ctx.buildApp(brokenKakao))
    const { state } = await startLogin(agent)

    assertLoginErrorRedirect(await callback(agent, { state }), 'server_error')
    assert.equal(await ctx.countRows('users'), 0)
  })

  describe('실패로 끝난 콜백도 state를 세션 저장소에서 지운다', () => {
    it('a) 카카오 API 실패 뒤 같은 state로 다시 콜백 → invalid_state, 토큰 교환은 처음 1번뿐', async () => {
      const kakao = createFakeKakaoClient({ failAt: 'token' })
      const agent = request.agent(ctx.buildApp(kakao))
      const { res: startRes, state } = await startLogin(agent)

      assertLoginErrorRedirect(await callback(agent, { state }), 'kakao_api_failed')
      assert.deepEqual(await readOurSessionData(ctx.pool, sessionCookieFrom(startRes)), {})

      assertLoginErrorRedirect(await callback(agent, { state }), 'invalid_state')
      assert.equal(kakao.calls.exchange.length, 1)
    })

    it('b) 동의 취소(?error=) 뒤 같은 state로 다시 콜백 → invalid_state, 토큰 교환 안 함', async () => {
      const kakao = createFakeKakaoClient()
      const agent = request.agent(ctx.buildApp(kakao))
      const { res: startRes, state } = await startLogin(agent)
      const denied = await agent.get('/api/auth/kakao/callback').query({ error: 'access_denied', state })
      assertLoginErrorRedirect(denied, 'kakao_login_denied')
      assert.deepEqual(await readOurSessionData(ctx.pool, sessionCookieFrom(startRes)), {})

      assertLoginErrorRedirect(await callback(agent, { state }), 'invalid_state')
      assert.equal(kakao.calls.exchange.length, 0)
    })
  })
})
