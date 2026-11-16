// Canvas 응답 → 저장할 값 (ADR 0008 "Canvas 값이 칼럼보다 길 때" · "Canvas 링크 규칙").
// 한 항목 · 한 칼럼 때문에 동기화 전체가 실패하지 않도록, 저장 전에 자르거나(NULL로) 건너뛴다.
import { createHash } from 'node:crypto'

export const TITLE_MAX_LENGTH = 255
export const URL_MAX_LENGTH = 2048
export const BODY_MAX_BYTES = 1024 * 1024
export const UNTITLED = '(제목 없음)'

function isCanvasId(value) {
  return Number.isSafeInteger(value) && value > 0
}

// 코드포인트 기준으로 자른다 (이모지 같은 서로게이트 쌍을 반으로 깨지 않음)
function truncate(value) {
  const codePoints = Array.from(value)
  return codePoints.length > TITLE_MAX_LENGTH ? codePoints.slice(0, TITLE_MAX_LENGTH).join('') : value
}

function titleOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? truncate(value) : UNTITLED
}

function dateOf(value) {
  if (typeof value !== 'string') {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function hashOf(values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

export function isBodyTooLarge(message) {
  return typeof message === 'string' && Buffer.byteLength(message, 'utf8') > BODY_MAX_BYTES
}

// CANVAS_BASE_URL과 출처(프로토콜 · 호스트 · 포트)가 정확히 같고 계정 정보가 없을 때만 그대로, 아니면 null
export function safeCanvasUrl(value, { baseUrl }) {
  if (typeof value !== 'string' || value === '' || value.length > URL_MAX_LENGTH) {
    return null
  }
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.origin !== new URL(baseUrl).origin || url.username || url.password) {
    return null
  }
  return value
}

// 이름이 없거나 접근 제한(access_restricted_by_date) 과목은 건너뛴다
export function normalizeCourse(raw) {
  if (!raw || !isCanvasId(raw.id) || raw.access_restricted_by_date === true) {
    return null
  }
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    return null
  }
  return { canvasCourseId: raw.id, name: truncate(raw.name) }
}

// 미게시 과제는 저장하지 않는다. 마감(due_at)은 사용자별 값이라 해시에 넣지 않는다.
export function normalizeAssignment(raw, { baseUrl }) {
  if (!raw || !isCanvasId(raw.id) || raw.published === false) {
    return null
  }
  const title = titleOf(raw.name)
  const htmlUrl = safeCanvasUrl(raw.html_url, { baseUrl })
  return { canvasId: raw.id, title, htmlUrl, dueAt: dateOf(raw.due_at), contentHash: hashOf([title, htmlUrl]) }
}

// 본문 HTML은 정제하지 않고 그대로 둔다(화면에서 innerHTML 금지, api.md). 1 MiB를 넘으면 자르지 않고 null.
export function normalizeAnnouncement(raw, { baseUrl }) {
  if (!raw || !isCanvasId(raw.id)) {
    return null
  }
  const title = titleOf(raw.title)
  const body = typeof raw.message === 'string' && !isBodyTooLarge(raw.message) ? raw.message : null
  const htmlUrl = safeCanvasUrl(raw.html_url, { baseUrl })
  const postedAt = dateOf(raw.posted_at)
  return { canvasId: raw.id, title, body, htmlUrl, postedAt, contentHash: hashOf([title, body, htmlUrl]) }
}
