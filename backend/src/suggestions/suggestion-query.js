// 제안 목록 요청 값 검사 (ADR 0011). 규칙에 안 맞으면 고정 코드로 거부(조용히 기본값으로 바꾸지 않음).
// 커서는 불투명 문자열(base64url): pending은 시작 시각 순이라 "시작ms_id", 그 밖은 최신순이라 "id"
import { positiveId, DEFAULT_LIMIT, MAX_LIMIT } from '../notifications/notification-query.js'

export const SUGGESTION_STATUSES = ['pending', 'expired', 'accepted', 'rejected']
const BASE64URL = /^[A-Za-z0-9_-]+$/
const PENDING_CURSOR = /^(0|[1-9][0-9]*)_([1-9][0-9]*)$/

export const SUGGESTION_QUERY_MESSAGES = {
  invalid_status: `status는 ${SUGGESTION_STATUSES.join(' · ')} 중 하나여야 합니다.`,
  invalid_limit: `limit은 1 ~ ${MAX_LIMIT} 사이의 정수여야 합니다.`,
  invalid_cursor: 'cursor가 올바르지 않습니다. 목록 응답의 nextCursor를 그대로 보내 주세요.',
}

const wrap = (text) => Buffer.from(text).toString('base64url')

export function encodeSuggestionCursor(status, row) {
  return wrap(status === 'pending' ? `${row.start_at.getTime()}_${row.id}` : String(row.id))
}

// → { startAt?, id } | null. 다시 감쌌을 때 같은 문자열이어야 한다(다른 표기 거부)
function decodeCursor(status, cursor) {
  if (typeof cursor !== 'string' || !BASE64URL.test(cursor)) {
    return null
  }
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  if (wrap(text) !== cursor) {
    return null
  }
  if (status !== 'pending') {
    const id = positiveId(text)
    return id === null ? null : { id }
  }
  const match = text.match(PENDING_CURSOR)
  const [ms, id] = match ? [Number(match[1]), positiveId(match[2])] : [NaN, null]
  return Number.isSafeInteger(ms) && id !== null ? { startAt: new Date(ms), id } : null
}

function parseLimit(limit) {
  if (limit === undefined) {
    return DEFAULT_LIMIT
  }
  const value = positiveId(limit)
  return value !== null && value <= MAX_LIMIT ? value : null
}

// 결과: { value: { status, limit, after } } | { error: { code } }
export function parseSuggestionQuery(query) {
  const status = query.status ?? 'pending'
  if (!SUGGESTION_STATUSES.includes(status)) {
    return { error: { code: 'invalid_status' } }
  }
  const limit = parseLimit(query.limit)
  if (limit === null) {
    return { error: { code: 'invalid_limit' } }
  }
  const after = query.cursor === undefined ? null : decodeCursor(status, query.cursor)
  if (query.cursor !== undefined && after === null) {
    return { error: { code: 'invalid_cursor' } }
  }
  return { value: { status, limit, after } }
}
