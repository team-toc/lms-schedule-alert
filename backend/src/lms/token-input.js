// Canvas 토큰 입력 검사 (ADR 0008). 앞뒤 공백을 지운 뒤 길이 · 문자를 본다.
// Canvas 개인 토큰 형식(<숫자>~<영숫자>)은 문서에 없어 실측 기준으로 영문 · 숫자 · ~ 만 받는다.
export const TOKEN_MAX_LENGTH = 200
const TOKEN_PATTERN = /^[A-Za-z0-9~]+$/

export const TOKEN_VALIDATION_MESSAGES = {
  missing_token: 'Canvas 토큰을 입력해 주세요.',
  token_too_long: `Canvas 토큰이 너무 깁니다. ${TOKEN_MAX_LENGTH}자까지 입력할 수 있습니다.`,
  invalid_token_format: 'Canvas 토큰 형식이 올바르지 않습니다. 영문 · 숫자 · ~ 만 쓸 수 있습니다.',
}

// 결과: { value: token } 또는 { error: { code, field: 'token' } }
export function validateTokenInput(body) {
  const raw = body?.token
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: { code: 'missing_token', field: 'token' } }
  }
  const token = raw.trim()
  if (token.length > TOKEN_MAX_LENGTH) {
    return { error: { code: 'token_too_long', field: 'token' } }
  }
  if (!TOKEN_PATTERN.test(token)) {
    return { error: { code: 'invalid_token_format', field: 'token' } }
  }
  return { value: token }
}
