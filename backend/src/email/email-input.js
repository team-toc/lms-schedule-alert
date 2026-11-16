// 이메일 가입 · 로그인 입력 검증과 정규화 (ADR 0007). 외부 의존 없음.
export const EMAIL_MAX_LENGTH = 254
const EMAIL_LOCAL_MAX_LENGTH = 64
const DOMAIN_LABEL_MAX_LENGTH = 63
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

// ASCII만 받는다. 로컬 파트는 RFC 5322 atext와 점, 도메인 라벨은 영문 · 숫자 · 하이픈(앞뒤는 하이픈 불가)
const LOCAL_PART_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const MASKED_LOCAL_SUFFIX = '***'

export const VALIDATION_MESSAGES = {
  missing_email: '이메일을 입력해 주세요.',
  invalid_email: '이메일 형식이 올바르지 않습니다.',
  email_too_long: `이메일은 ${EMAIL_MAX_LENGTH}자 이하여야 합니다.`,
  missing_password: '비밀번호를 입력해 주세요.',
  password_too_short: `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`,
  password_too_long: `비밀번호는 ${PASSWORD_MAX_LENGTH}자 이하여야 합니다.`,
  invalid_display_name: '이름 형식이 올바르지 않습니다.',
}

const fail = (code, field) => ({ error: { code, field } })
const codePointLength = (text) => [...text].length

export function normalizeEmail(email) {
  return email.trim().toLowerCase()
}

// 로그용: 로컬 파트 첫 글자만 남긴다 (y***@example.com)
export function maskEmail(email) {
  const at = email.indexOf('@')
  if (at < 1) {
    return MASKED_LOCAL_SUFFIX
  }
  return `${email[0]}${MASKED_LOCAL_SUFFIX}${email.slice(at)}`
}

function isValidDomain(domain) {
  const labels = domain.split('.')
  return labels.length >= 2 && labels.every((label) => label.length <= DOMAIN_LABEL_MAX_LENGTH && DOMAIN_LABEL_PATTERN.test(label))
}

function isValidEmailFormat(email) {
  const parts = email.split('@')
  if (parts.length !== 2) {
    return false
  }
  const [local, domain] = parts
  return local.length <= EMAIL_LOCAL_MAX_LENGTH && LOCAL_PART_PATTERN.test(local) && isValidDomain(domain)
}

// 결과: { email } 또는 { error }
function checkEmail(rawEmail) {
  if (rawEmail === undefined || rawEmail === null) {
    return fail('missing_email', 'email')
  }
  if (typeof rawEmail !== 'string') {
    return fail('invalid_email', 'email')
  }
  const email = normalizeEmail(rawEmail)
  if (email === '') {
    return fail('missing_email', 'email')
  }
  if (email.length > EMAIL_MAX_LENGTH) {
    return fail('email_too_long', 'email')
  }
  return isValidEmailFormat(email) ? { email } : fail('invalid_email', 'email')
}

// 같은 비밀번호가 입력 방식에 따라 NFC · NFD로 달라지지 않게 NFC로 바꾼 뒤 길이를 센다. 공백은 지우지 않는다.
function checkPassword(rawPassword, { minLength }) {
  if (typeof rawPassword !== 'string' || rawPassword === '') {
    return fail('missing_password', 'password')
  }
  const password = rawPassword.normalize('NFC')
  const length = codePointLength(password)
  if (length < minLength) {
    return fail('password_too_short', 'password')
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return fail('password_too_long', 'password')
  }
  return { password }
}

function checkDisplayName(rawDisplayName) {
  if (rawDisplayName === undefined || rawDisplayName === null) {
    return { displayName: null }
  }
  // 공백 정리 · 기본 이름 · 100자 제한은 계정 로직(normalizeDisplayName)이 소셜과 같은 규칙으로 처리한다
  return typeof rawDisplayName === 'string' ? { displayName: rawDisplayName } : fail('invalid_display_name', 'displayName')
}

function asObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
}

// 틀린 항목이 여러 개면 첫 번째(이메일 → 비밀번호 → 이름)만 돌려준다
export function validateSignupInput(body) {
  const input = asObject(body)
  const email = checkEmail(input.email)
  if (email.error) {
    return email
  }
  const password = checkPassword(input.password, { minLength: PASSWORD_MIN_LENGTH })
  if (password.error) {
    return password
  }
  const displayName = checkDisplayName(input.displayName)
  if (displayName.error) {
    return displayName
  }
  return { value: { email: email.email, password: password.password, displayName: displayName.displayName } }
}

// 로그인은 비밀번호 하한을 보지 않는다(틀린 비밀번호와 같은 401로 처리). 상한은 해시 계산 비용 때문에 본다.
export function validateLoginInput(body) {
  const input = asObject(body)
  const email = checkEmail(input.email)
  if (email.error) {
    return email
  }
  const password = checkPassword(input.password, { minLength: 0 })
  if (password.error) {
    return password
  }
  return { value: { email: email.email, password: password.password } }
}
