import { promisify } from 'node:util'

// 로그인 성공 처리(소셜 · 이메일 공통). 세션 고정 공격 방지: 로그인 전 세션을 버리고 새 세션 ID로 발급한 뒤 userId만 넣는다.
export async function startUserSession(req, user) {
  await promisify(req.session.regenerate.bind(req.session))()
  req.session.userId = user.id
}

// /me · 이메일 가입 · 로그인 응답 본문
export function toUserResponse(user) {
  return { id: user.id, displayName: user.displayName, onboardingStep: user.onboardingStep }
}
