import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import request from 'supertest'
import { openTestContext, GOOGLE_TEST_CONFIG, TEST_GOOGLE_CLIENT_SECRET } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'
import {
  createFakeGoogleTokenEndpoint,
  idTokenClaims,
  makeIdToken,
  jsonResponse,
  tokenResponseBody,
  networkError,
  timesOut,
} from './helpers/fake-google.js'
import { sessionCookieFrom, sessionIdFrom, assertLoginErrorRedirect } from './helpers/auth-flow.js'
import { startGoogleLogin, googleCallback } from './helpers/google-flow.js'
import { readOurSessionData } from './helpers/session-data.js'
import { createGoogleClient } from '../src/google/google-client.js'

const SENSITIVE_CODE = 'google-auth-code-MUST-NOT-LEAK'

function createCapturingLogger() {
  const lines = []
  const logger = pino({ level: 'trace' }, { write: (line) => lines.push(line) })
  return { logger, text: () => lines.join('') }
}

describe('Google 콜백 실패 경로', () => {
  let ctx
  let endpoint

  function buildApp({ logger } = {}) {
    const googleClient = createGoogleClient({ config: GOOGLE_TEST_CONFIG, fetchFn: endpoint.fetchFn })
    return ctx.buildApp(createFakeKakaoClient(), { googleClient, logger })
  }

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    endpoint = createFakeGoogleTokenEndpoint()
  })
  after(async () => {
    await ctx.close()
  })

  // 6. 토큰 교환 · 사용자 확인 실패: 에러 리다이렉트, 세션 발급 안 됨, 토큰 요청 1번만
  const failures = [
    ['토큰 교환 실패(400 invalid_grant)', () => () => jsonResponse(400, { error: 'invalid_grant' })],
    ['사용자 확인 실패(aud 불일치)', () => () => jsonResponse(200, tokenResponseBody(makeIdToken(idTokenClaims({ aud: 'other' }))))],
    ['네트워크 오류', () => networkError],
    ['타임아웃', () => timesOut],
  ]
  for (const [label, makeResponder] of failures) {
    it(`6. ${label} → google_api_failed, 세션 발급 안 됨, 토큰 요청 1번`, async () => {
      const agent = request.agent(buildApp())
      const { state } = await startGoogleLogin(agent)
      endpoint.respond(SENSITIVE_CODE, makeResponder())

      const res = await googleCallback(agent, { code: SENSITIVE_CODE, state })

      assertLoginErrorRedirect(res, 'google_api_failed')
      assert.equal(endpoint.requests.length, 1)
      assert.equal(await ctx.countRows('users'), 0)
      await agent.get('/api/auth/me').expect(401)
    })
  }

  describe('실패로 끝난 콜백도 state · nonce를 세션 저장소에서 지운다', () => {
    it('로그인 시작 후 세션에는 googleOAuth { state, nonce } 하나만 있다', async () => {
      const { res, state, nonce } = await startGoogleLogin(request.agent(buildApp()))

      assert.deepEqual(await readOurSessionData(ctx.pool, sessionCookieFrom(res)), { googleOAuth: { state, nonce } })
    })

    it('a) Google API 실패 뒤 같은 state로 다시 콜백 → invalid_state, 토큰 요청은 처음 1번뿐', async () => {
      const agent = request.agent(buildApp())
      const { res: startRes, state } = await startGoogleLogin(agent)
      endpoint.respond('code', () => jsonResponse(400, { error: 'invalid_grant' }))

      assertLoginErrorRedirect(await googleCallback(agent, { code: 'code', state }), 'google_api_failed')
      assert.deepEqual(await readOurSessionData(ctx.pool, sessionCookieFrom(startRes)), {})

      assertLoginErrorRedirect(await googleCallback(agent, { code: 'code', state }), 'invalid_state')
      assert.equal(endpoint.requests.length, 1)
    })

    it('b) 동의 취소(?error=) 뒤 같은 state로 다시 콜백 → invalid_state, 토큰 요청 안 함', async () => {
      const agent = request.agent(buildApp())
      const { res: startRes, state } = await startGoogleLogin(agent)
      const denied = await agent.get('/api/auth/google/callback').query({ error: 'access_denied', state })
      assertLoginErrorRedirect(denied, 'google_login_denied')
      assert.deepEqual(await readOurSessionData(ctx.pool, sessionCookieFrom(startRes)), {})

      assertLoginErrorRedirect(await googleCallback(agent, { state }), 'invalid_state')
      assert.equal(endpoint.requests.length, 0)
    })

    it('c) 실패로 끝난 로그인의 nonce는 다음 로그인에서 쓸 수 없다', async () => {
      const agent = request.agent(buildApp())
      const first = await startGoogleLogin(agent)
      endpoint.respond('first-code', () => jsonResponse(400, { error: 'invalid_grant' }))
      assertLoginErrorRedirect(await googleCallback(agent, { code: 'first-code', state: first.state }), 'google_api_failed')
      const second = await startGoogleLogin(agent)
      endpoint.issueIdToken('second-code', idTokenClaims({ nonce: first.nonce }))

      const res = await googleCallback(agent, { code: 'second-code', state: second.state })

      assertLoginErrorRedirect(res, 'google_api_failed')
      assert.notEqual(second.nonce, first.nonce)
      assert.equal(await ctx.countRows('users'), 0)
    })
  })

  it('state는 맞지만 code가 없음 → invalid_request, 토큰 요청 안 함', async () => {
    const agent = request.agent(buildApp())
    const { state } = await startGoogleLogin(agent)

    assertLoginErrorRedirect(await agent.get('/api/auth/google/callback').query({ state }), 'invalid_request')
    assert.equal(endpoint.requests.length, 0)
  })

  describe('8. 로그에 인가 코드 · 토큰 · client_secret · 세션 ID가 없다', () => {
    async function runAndCaptureLogs(prepare) {
      const capture = createCapturingLogger()
      const agent = request.agent(buildApp({ logger: capture.logger }))
      const { res: startRes, state, nonce } = await startGoogleLogin(agent)
      const secrets = prepare({ nonce })
      const res = await googleCallback(agent, { code: SENSITIVE_CODE, state: secrets.state ?? state })
      return { res, logText: capture.text(), sessionId: sessionIdFrom(sessionCookieFrom(startRes)), secrets }
    }

    function assertNoSecrets(logText, { sessionId, tokens = [] }) {
      assert.ok(logText.length > 0, '로그가 남아야 함')
      for (const secret of [SENSITIVE_CODE, TEST_GOOGLE_CLIENT_SECRET, sessionId, 'fake-google-access-token', ...tokens]) {
        assert.ok(!logText.includes(secret), '로그에 민감 정보가 있음')
      }
    }

    it('state 불일치', async () => {
      const { res, logText, sessionId } = await runAndCaptureLogs(() => ({ state: 'forged-state' }))

      assertLoginErrorRedirect(res, 'invalid_state')
      assertNoSecrets(logText, { sessionId })
      assert.ok(logText.includes('invalid_state'), '실패 이유는 남아야 함')
    })

    it('토큰 교환 실패', async () => {
      const { res, logText, sessionId } = await runAndCaptureLogs(() => {
        endpoint.respond(SENSITIVE_CODE, () => jsonResponse(400, { error: 'invalid_grant' }))
        return {}
      })

      assertLoginErrorRedirect(res, 'google_api_failed')
      assertNoSecrets(logText, { sessionId })
      assert.ok(logText.includes('google_api_failed'))
    })

    it('id_token 검증 실패(만료): id_token 문자열이 로그에 없다', async () => {
      const { res, logText, sessionId, secrets } = await runAndCaptureLogs(({ nonce }) => {
        const idToken = makeIdToken(idTokenClaims({ nonce, exp: Math.floor(Date.now() / 1000) - 60 }))
        endpoint.respond(SENSITIVE_CODE, () => jsonResponse(200, tokenResponseBody(idToken, SENSITIVE_CODE)))
        return { idToken }
      })

      assertLoginErrorRedirect(res, 'google_api_failed')
      assertNoSecrets(logText, { sessionId, tokens: [secrets.idToken] })
    })

    it('로그인 성공: id_token · 액세스 토큰이 로그에 없다', async () => {
      const { res, logText, sessionId, secrets } = await runAndCaptureLogs(({ nonce }) => {
        const idToken = makeIdToken(idTokenClaims({ nonce }))
        endpoint.respond(SENSITIVE_CODE, () => jsonResponse(200, tokenResponseBody(idToken, SENSITIVE_CODE)))
        return { idToken }
      })

      assert.equal(res.status, 302)
      assertNoSecrets(logText, { sessionId, tokens: [secrets.idToken] })
      assert.ok(logText.includes('login_succeeded'))
    })
  })
})
