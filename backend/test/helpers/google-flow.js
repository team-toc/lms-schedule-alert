import assert from 'node:assert/strict'
import { sessionCookieFrom } from './auth-flow.js'
import { idTokenClaims } from './fake-google.js'

export const DEFAULT_GOOGLE_CODE = 'fake-google-code'

// GET /api/auth/google → Google로 가는 Location에서 state · nonce를 꺼낸다
export async function startGoogleLogin(agent) {
  const res = await agent.get('/api/auth/google').expect(302)
  const location = new URL(res.headers.location)
  const state = location.searchParams.get('state')
  const nonce = location.searchParams.get('nonce')
  assert.ok(state && nonce, 'Location에 state · nonce가 있어야 함')
  return { res, location, state, nonce }
}

export function googleCallback(agent, { code = DEFAULT_GOOGLE_CODE, state }) {
  return agent.get('/api/auth/google/callback').query({ code, state })
}

// 로그인을 끝까지 진행한다. 가짜 토큰 엔드포인트가 이번 nonce를 담은 id_token을 내주게 한다.
export async function googleLogin(agent, endpoint, { code = DEFAULT_GOOGLE_CODE, claims = {} } = {}) {
  const { state, nonce } = await startGoogleLogin(agent)
  endpoint.issueIdToken(code, idTokenClaims({ nonce, ...claims }))
  const res = await googleCallback(agent, { code, state }).expect(302)
  return { res, cookie: sessionCookieFrom(res), state, nonce }
}
