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
  neverResponds,
} from './helpers/fake-google.js'
import { sessionCookieFrom, sessionIdFrom, assertLoginErrorRedirect } from './helpers/auth-flow.js'
import { startGoogleLogin, googleCallback } from './helpers/google-flow.js'
import { createGoogleClient } from '../src/google/google-client.js'

const SENSITIVE_CODE = 'google-auth-code-MUST-NOT-LEAK'
const SHORT_TIMEOUT_MS = 30

function createCapturingLogger() {
  const lines = []
  const logger = pino({ level: 'trace' }, { write: (line) => lines.push(line) })
  return { logger, text: () => lines.join('') }
}

describe('Google 콜백 실패 경로', () => {
  let ctx
  let endpoint

  function buildApp({ logger, timeoutMs } = {}) {
    const googleClient = createGoogleClient({ config: GOOGLE_TEST_CONFIG, fetchFn: endpoint.fetchFn, timeoutMs })
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
    ['타임아웃', () => neverResponds],
  ]
  for (const [label, makeResponder] of failures) {
    it(`6. ${label} → google_api_failed, 세션 발급 안 됨, 토큰 요청 1번`, async () => {
      const agent = request.agent(buildApp({ timeoutMs: SHORT_TIMEOUT_MS }))
      const { state } = await startGoogleLogin(agent)
      endpoint.respond(SENSITIVE_CODE, makeResponder())

      const res = await googleCallback(agent, { code: SENSITIVE_CODE, state })

      assertLoginErrorRedirect(res, 'google_api_failed')
      assert.equal(endpoint.requests.length, 1)
      assert.equal(await ctx.countRows('users'), 0)
      await agent.get('/api/auth/me').expect(401)
    })
  }

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
