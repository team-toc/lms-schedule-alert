import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import session from 'express-session'
import pino from 'pino'
import request from 'supertest'
import { mountOAuthProvider } from '../src/auth/oauth-flow.js'
import { createSessionMiddleware } from '../src/session.js'
import { createHttpLogger } from '../src/logger.js'
import { startLogin, callback } from './helpers/auth-flow.js'

const FRONTEND_URL = 'http://frontend.test'
const CONFIG = {
  isProduction: false,
  frontendUrl: FRONTEND_URL,
  session: { secret: 'oauth-flow-test-secret-0123456789abcdef', ttlMs: 60 * 1000 },
}
const PROVIDER_NAME = 'kakao' // auth-flow 헬퍼가 /api/auth/kakao 경로를 쓰므로 이름만 빌린다

class FakeProviderApiError extends Error {}

// 상세 정보(describeFailure)가 공통 필드 이름을 일부러 모두 쓰는 가짜 제공자
function createCollidingProvider() {
  return {
    name: PROVIDER_NAME,
    sessionKey: 'fakeOAuth',
    usesNonce: false,
    buildAuthorizeUrl: ({ state }) => `https://provider.fake/authorize?state=${state}`,
    async fetchProfile() {
      throw new FakeProviderApiError('provider down')
    },
    isApiError: (err) => err instanceof FakeProviderApiError,
    describeFailure: () => ({ event: 'OVERRIDDEN', provider: 'OVERRIDDEN', reason: 'OVERRIDDEN', stage: 'token_exchange' }),
    errors: { denied: 'fake_login_denied', apiFailed: 'fake_api_failed' },
  }
}

function buildApp(provider) {
  const entries = []
  const logger = pino({ level: 'trace' }, { write: (line) => entries.push(JSON.parse(line)) })
  const app = express()
  app.use(createHttpLogger(logger))
  app.use(createSessionMiddleware({ config: CONFIG, store: new session.MemoryStore() }))
  const router = express.Router()
  const accountService = {
    loginWithIdentity: () => assert.fail('API 실패 경로에서는 계정 로직에 닿으면 안 됨'),
  }
  mountOAuthProvider(router, { config: CONFIG, provider, accountService })
  app.use('/api/auth', router)
  return { app, entries }
}

describe('공통 OAuth 흐름: 로그', () => {
  it('공통 필드(event · provider · reason)는 제공자 상세 정보로 덮이지 않고, 겹치지 않는 상세는 남는다', async () => {
    const { app, entries } = buildApp(createCollidingProvider())
    const agent = request.agent(app)
    const { state } = await startLogin(agent)

    await callback(agent, { state }).expect(302)

    const failed = entries.filter((entry) => entry.event === 'login_failed')
    assert.equal(failed.length, 1, 'login_failed 로그가 정확히 1개')
    assert.equal(failed[0].provider, PROVIDER_NAME)
    assert.equal(failed[0].reason, 'fake_api_failed')
    assert.equal(failed[0].stage, 'token_exchange')
    assert.ok(!JSON.stringify(entries).includes('OVERRIDDEN'), '상세 정보가 공통 필드를 덮었음')
  })
})
