// 제안 목록 · 수락 · 거절 (ADR 0011). 남의 것 · 없음은 404(존재를 드러내지 않음), 이미 처리 409, 만료 수락 409(만료 거절은 허용).
// 수락 = 앱 일정 만들기: 보낸 칸만 제안 값 위에 덮어쓰고 앱 일정 수정과 같은 검사(parseScheduleUpdate).
// 결과: { suggestions, nextCursor } | { suggestion, schedule } | { rejected: true } | { failure: { status, error, field? } }
import { parseScheduleUpdate, MAX_TITLE_CODE_POINTS } from '../calendar/schedule-input.js'
import { toScheduleItem } from '../calendar/schedule-item.js'
import { parseSuggestionQuery, encodeSuggestionCursor } from './suggestion-query.js'
import { toSuggestionItem, isExpired } from './suggestion-item.js'

const NOT_FOUND = { failure: { status: 404, error: 'suggestion_not_found' } }
const ALREADY_DECIDED = { failure: { status: 409, error: 'suggestion_already_decided' } }
const EXPIRED = { failure: { status: 409, error: 'suggestion_expired' } }
const KIND_LABELS = { exam: '시험', cancellation: '휴강', makeup: '보강', deadline: '마감', other: '일정' }
const EDITABLE = ['title', 'startAt', 'endAt', 'isAllDay']

// 기본값: 제목 "종류: 공지 제목"(255자로 자름) · 제안 시각
function defaultsOf(row) {
  const title = Array.from(`${KIND_LABELS[row.kind]}: ${row.announcement_title}`).slice(0, MAX_TITLE_CODE_POINTS).join('').trim()
  return { title, startAt: row.start_at, endAt: row.end_at, isAllDay: Boolean(row.is_all_day) }
}

function scheduleValues(body, row) {
  const defaults = defaultsOf(row)
  const edited = body !== null && typeof body === 'object' && EDITABLE.some((key) => body[key] !== undefined)
  return edited ? parseScheduleUpdate(body, defaults) : { value: defaults }
}

export function createSuggestionService({ repository, now }) {
  async function list(userId, query) {
    const parsed = parseSuggestionQuery(query)
    if (parsed.error) {
      return { failure: { status: 400, error: parsed.error.code } }
    }
    const at = now()
    const rows = await repository.list(userId, parsed.value, at)
    const page = rows.slice(0, parsed.value.limit)
    const nextCursor = rows.length > page.length ? encodeSuggestionCursor(parsed.value.status, page[page.length - 1]) : null
    return { suggestions: page.map((row) => toSuggestionItem(row, at)), nextCursor }
  }

  // 공통 검사: 없음 404 → 이미 처리 409 → (수락이면) 만료 409
  const precheck = (row, at, { accepting }) => {
    if (!row) return NOT_FOUND
    if (row.status !== 'pending') return ALREADY_DECIDED
    return accepting && isExpired(row, at) ? EXPIRED : null
  }

  function accept(userId, id, body) {
    if (id === null) return NOT_FOUND
    const at = now()
    return repository.withLockedSuggestion(userId, id, async (row, connection) => {
      const blocked = precheck(row, at, { accepting: true })
      if (blocked) return blocked
      const { value, error } = scheduleValues(body, row)
      if (error) return { failure: { status: 400, error: error.code, field: error.field } }
      const schedule = await repository.createSchedule(connection, userId, value)
      const item = await repository.markDecided(connection, userId, id, { status: 'accepted', scheduleId: schedule.id, at })
      return { suggestion: toSuggestionItem(item, at), schedule: toScheduleItem(schedule) }
    })
  }

  function reject(userId, id) {
    if (id === null) return NOT_FOUND
    const at = now()
    return repository.withLockedSuggestion(userId, id, async (row, connection) => {
      const blocked = precheck(row, at, { accepting: false })
      if (blocked) return blocked
      await repository.markDecided(connection, userId, id, { status: 'rejected', scheduleId: null, at })
      return { rejected: true }
    })
  }

  return { list, accept, reject }
}
