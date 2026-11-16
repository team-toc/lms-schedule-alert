// Canvas 계정 id(/api/v1/users/self의 id) 판단 (ADR 0009 4절). Canvas id는 64비트 정수라 2^53을 넘을 수 있으므로
// 10진수 문자열로만 다룬다. 믿을 수 없는 값은 null(→ 같은 계정으로 보지 않음)과 이유 코드를 돌려준다. 이유 코드에 값은 넣지 않는다.
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/
const MAX_UNSIGNED_64 = 18446744073709551615n

export const ACCOUNT_ID_REASONS = {
  missing: 'missing',
  // 문자열 id 헤더를 무시하고 숫자로 와서, JSON.parse가 이미 정밀도를 잃었을 수 있음
  unsafeNumber: 'unsafe_number',
  invalidFormat: 'invalid_format',
}

const unusable = (reason) => ({ id: null, reason })

function fromNumber(raw) {
  if (Number.isSafeInteger(raw) && raw > 0) {
    return { id: String(raw), reason: null }
  }
  return unusable(Number.isInteger(raw) && raw > 0 ? ACCOUNT_ID_REASONS.unsafeNumber : ACCOUNT_ID_REASONS.invalidFormat)
}

// 결과: { id: '9001', reason: null } | { id: null, reason }
export function parseCanvasAccountId(raw) {
  if (raw === undefined || raw === null) {
    return unusable(ACCOUNT_ID_REASONS.missing)
  }
  if (typeof raw === 'number') {
    return fromNumber(raw)
  }
  if (typeof raw === 'string' && DECIMAL_ID.test(raw) && BigInt(raw) <= MAX_UNSIGNED_64) {
    return { id: raw, reason: null }
  }
  return unusable(ACCOUNT_ID_REASONS.invalidFormat)
}
