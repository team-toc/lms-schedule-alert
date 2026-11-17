// 알림 목록 · 읽음 요청 값 검사 (ADR 0009 API 절). 커서는 마지막 id를 base64url로 감싼 불투명 문자열.
// 커서 · limit · unread가 규칙에 안 맞으면 고정 코드로 거부한다(조용히 기본값으로 바꾸지 않음).
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 50
const POSITIVE_INTEGER = /^[1-9][0-9]*$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

export const NOTIFICATION_VALIDATION_MESSAGES = {
  invalid_cursor: 'cursor가 올바르지 않습니다. 목록 응답의 nextCursor를 그대로 보내 주세요.',
  invalid_limit: `limit은 1 ~ ${MAX_LIMIT} 사이의 정수여야 합니다.`,
  invalid_unread: 'unread는 true 또는 false여야 합니다.',
}

// 양의 안전 정수만 (앞자리 0 · 소수 · 지수 표기 · 공백 없음). 아니면 null
export function positiveId(text) {
  if (typeof text !== 'string' || !POSITIVE_INTEGER.test(text)) {
    return null
  }
  const id = Number(text)
  return Number.isSafeInteger(id) ? id : null
}

export const encodeCursor = (id) => Buffer.from(String(id)).toString('base64url')

// 다시 감쌌을 때 같은 문자열이어야 한다(패딩 · 다른 표기 거부)
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !BASE64URL.test(cursor)) {
    return null
  }
  const id = positiveId(Buffer.from(cursor, 'base64url').toString('utf8'))
  return id !== null && encodeCursor(id) === cursor ? id : null
}

function parseLimit(limit) {
  if (limit === undefined) {
    return DEFAULT_LIMIT
  }
  const value = positiveId(limit)
  return value !== null && value <= MAX_LIMIT ? value : null
}

// 결과: { value: { unreadOnly, limit, beforeId } } | { error: { code } }
export function parseListQuery(query) {
  const { unread, limit, cursor } = query
  if (unread !== undefined && unread !== 'true' && unread !== 'false') {
    return { error: { code: 'invalid_unread' } }
  }
  const parsedLimit = parseLimit(limit)
  if (parsedLimit === null) {
    return { error: { code: 'invalid_limit' } }
  }
  const beforeId = cursor === undefined ? null : decodeCursor(cursor)
  if (cursor !== undefined && beforeId === null) {
    return { error: { code: 'invalid_cursor' } }
  }
  return { value: { unreadOnly: unread === 'true', limit: parsedLimit, beforeId } }
}
