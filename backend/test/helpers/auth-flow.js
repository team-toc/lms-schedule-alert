import assert from 'node:assert/strict'
import { FRONTEND_URL } from './test-db.js'

export const SESSION_COOKIE_NAME = 'sid'
export const LOGIN_ERROR_URL = `${FRONTEND_URL}/login/error`

// 콜백 실패는 프론트 에러 경로로 302, 쿼리에는 error 코드 하나만
export function assertLoginErrorRedirect(res, errorCode) {
  assert.equal(res.status, 302)
  const location = new URL(res.headers.location)
  assert.equal(location.origin + location.pathname, LOGIN_ERROR_URL)
  assert.deepEqual([...location.searchParams], [['error', errorCode]])
}

// 서명된 쿠키 "sid=s%3A<세션ID>.<서명>"에서 세션 ID만 꺼낸다
export function sessionIdFrom(cookie) {
  const value = decodeURIComponent(cookie.split('=')[1])
  return value.slice(2, value.lastIndexOf('.'))
}

// Set-Cookie 헤더에서 세션 쿠키만 "sid=..." 형태로 꺼낸다
export function sessionCookieFrom(res) {
  const cookies = res.headers['set-cookie'] ?? []
  const cookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
  return cookie ? cookie.split(';')[0] : null
}

// GET /api/auth/kakao → 카카오로 가는 Location에서 state를 꺼낸다
export async function startLogin(agent) {
  const res = await agent.get('/api/auth/kakao').expect(302)
  const state = new URL(res.headers.location).searchParams.get('state')
  assert.ok(state, 'Location에 state가 있어야 함')
  return { state, res }
}

export function callback(agent, { code = 'fake-code', state }) {
  return agent.get('/api/auth/kakao/callback').query({ code, state })
}

// 로그인을 끝까지 진행하고 로그인된 세션 쿠키를 돌려준다
export async function login(agent, { code } = {}) {
  const { state } = await startLogin(agent)
  const res = await callback(agent, { code, state }).expect(302)
  return { res, cookie: sessionCookieFrom(res) }
}
