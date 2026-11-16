import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import request from 'supertest'
import { openTestContext, TEST_CLIENT_SECRET } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'
import { startLogin, callback, sessionCookieFrom, sessionIdFrom, assertLoginErrorRedirect } from './helpers/auth-flow.js'
import { createKakaoClient } from '../src/kakao/kakao-client.js'

const SENSITIVE_CODE = 'auth-code-MUST-NOT-LEAK'

// 모든 레벨의 로그를 문자열로 모으는 logger
function createCapturingLogger() {
  const lines = []
  const logger = pino({ level: 'trace' }, { write: (line) => lines.push(line) })
  return { logger, text: () => lines.join('') }
}

// 진짜 카카오 클라이언트에 "client_secret이 틀렸다"고 답하는 가짜 fetch를 끼운다
function createRejectingKakaoClient(kakaoConfig) {
  const fetchFn = async () =>
    new Response(JSON.stringify({ error: 'invalid_client', error_code: 'KOE010' }), { status: 401 })
  return createKakaoClient({ config: kakaoConfig, fetchFn })
}

function assertNoSecretsIn(logText, { sessionId }) {
  assert.ok(logText.length > 0, '실패 경로도 로그를 남겨야 함')
  assert.ok(!logText.includes(SENSITIVE_CODE), '로그에 인가 코드가 있음')
  assert.ok(!logText.includes(TEST_CLIENT_SECRET), '로그에 client_secret이 있음')
  assert.ok(!logText.includes(sessionId), '로그에 세션 ID가 있음')
}

describe('콜백 실패 경로의 로그에 민감 정보가 없다', () => {
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

  it('state 불일치: 인가 코드 · client_secret · 세션 ID가 로그에 없고, 에러 코드는 남는다', async () => {
    const capture = createCapturingLogger()
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient(), { logger: capture.logger }))
    const { res: startRes } = await startLogin(agent)
    const sessionId = sessionIdFrom(sessionCookieFrom(startRes))

    const res = await callback(agent, { code: SENSITIVE_CODE, state: 'forged-state' })

    assertLoginErrorRedirect(res, 'invalid_state')
    assertNoSecretsIn(capture.text(), { sessionId })
    assert.ok(capture.text().includes('invalid_state'), '실패 이유(에러 코드)는 로그에 남아야 함')
  })

  it('토큰 교환 실패(진짜 클라이언트 + 가짜 fetch): 인가 코드 · client_secret · 세션 ID가 로그에 없다', async () => {
    const capture = createCapturingLogger()
    const kakaoClient = createRejectingKakaoClient(ctx.config.kakao)
    const agent = request.agent(ctx.buildApp(kakaoClient, { logger: capture.logger }))
    const { res: startRes, state } = await startLogin(agent)
    const sessionId = sessionIdFrom(sessionCookieFrom(startRes))

    const res = await callback(agent, { code: SENSITIVE_CODE, state })

    assertLoginErrorRedirect(res, 'kakao_api_failed')
    assertNoSecretsIn(capture.text(), { sessionId })
    assert.ok(capture.text().includes('kakao_api_failed'))
  })
})
