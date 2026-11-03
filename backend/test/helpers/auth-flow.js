import assert from 'node:assert/strict'

export const SESSION_COOKIE_NAME = 'sid'

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
