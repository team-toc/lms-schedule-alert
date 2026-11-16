// 이메일 가입 · 로그인 요청과 테스트용 시계 · 해시 감시 도구
export const SIGNUP_PATH = '/api/auth/email/signup'
export const LOGIN_PATH = '/api/auth/email/login'
export const VALID_EMAIL = 'user@example.com'
export const VALID_PASSWORD = 'correct horse battery staple'
export const MINUTE_MS = 60 * 1000

export function signup(agent, body) {
  return agent.post(SIGNUP_PATH).send(body)
}

export function emailLogin(agent, body) {
  return agent.post(LOGIN_PATH).send(body)
}

// 실패 횟수 제한 테스트용 시계. now()만 쓰고 advance로 시간을 옮긴다.
export function createFakeClock(startMs = Date.UTC(2026, 10, 8, 0, 0, 0)) {
  let current = startMs
  return {
    now: () => current,
    advance(ms) {
      current += ms
    },
  }
}

// 실제 해시 모듈을 감싸 verify 호출 횟수를 센다 (없는 이메일에도 비교를 한 번 하는지 확인용)
export function createCountingHasher(realHasher) {
  const calls = { hash: 0, verify: 0 }
  return {
    calls,
    async hash(password) {
      calls.hash += 1
      return realHasher.hash(password)
    },
    async verify(passwordHash, password) {
      calls.verify += 1
      return realHasher.verify(passwordHash, password)
    },
  }
}
