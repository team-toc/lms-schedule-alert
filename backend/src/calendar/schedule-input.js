// 앱 자체 일정 입력 검사 (ADR 0010). 오류는 처음 하나만 { code, field }로.
// - 제목: 앞뒤 공백을 지운 뒤 1 ~ 255 코드포인트
// - isAllDay = false(기본): startAt · endAt은 시간대가 붙은 ISO 8601만(캘린더 기간과 같은 파서)
// - isAllDay = true: 'YYYY-MM-DD'만, endAt은 마지막 날 다음 날(미포함) → 서울 자정의 UTC 시각
// - 시작 < 끝 (길이 0 일정은 앱에서 만들지 않는다. iCloud에서 온 것만 저장)
import { parseInstant } from './calendar-range.js'
import { parseDateOnly, seoulMidnight } from './seoul-time.js'

export const MAX_TITLE_CODE_POINTS = 255

export const SCHEDULE_VALIDATION_MESSAGES = {
  missing_title: '제목을 넣어 주세요.',
  invalid_title: '제목은 글자여야 합니다.',
  title_too_long: `제목은 ${MAX_TITLE_CODE_POINTS}자까지 쓸 수 있습니다.`,
  invalid_is_all_day: 'isAllDay는 true 또는 false여야 합니다.',
  missing_start_at: '시작(startAt)을 넣어 주세요.',
  invalid_start_at: '시작(startAt) 형식이 틀렸습니다. 하루 종일이면 YYYY-MM-DD, 아니면 시간대가 붙은 ISO 8601 시각(예: 2026-11-20T10:00:00+09:00)입니다.',
  missing_end_at: '끝(endAt)을 넣어 주세요.',
  invalid_end_at: '끝(endAt) 형식이 틀렸습니다. 하루 종일이면 YYYY-MM-DD(마지막 날 다음 날), 아니면 시간대가 붙은 ISO 8601 시각입니다.',
  invalid_range: '끝(endAt)은 시작(startAt)보다 뒤여야 합니다.',
  empty_update: '바꿀 칸(title · startAt · endAt · isAllDay)을 하나 이상 보내 주세요.',
}

const fail = (code, field) => ({ error: { code, field } })

function parseTitle(value) {
  if (value === undefined || value === null) {
    return fail('missing_title', 'title')
  }
  if (typeof value !== 'string') {
    return fail('invalid_title', 'title')
  }
  const title = value.trim()
  if (title === '') {
    return fail('missing_title', 'title')
  }
  return [...title].length > MAX_TITLE_CODE_POINTS ? fail('title_too_long', 'title') : { value: title }
}

// field: 'startAt' | 'endAt'. 결과: { value: Date } | { error }
function parseTime(value, { isAllDay, field }) {
  const prefix = field === 'startAt' ? 'start_at' : 'end_at'
  if (value === undefined || value === null || value === '') {
    return fail(`missing_${prefix}`, field)
  }
  if (isAllDay) {
    const date = parseDateOnly(value)
    return date ? { value: seoulMidnight(date) } : fail(`invalid_${prefix}`, field)
  }
  const instant = parseInstant(value)
  return instant instanceof Date ? { value: instant } : fail(`invalid_${prefix}`, field)
}

function parseIsAllDay(value) {
  if (value === undefined) {
    return { value: undefined }
  }
  return typeof value === 'boolean' ? { value } : fail('invalid_is_all_day', 'isAllDay')
}

function checkRange({ startAt, endAt }) {
  return startAt.getTime() < endAt.getTime() ? null : { code: 'invalid_range', field: 'endAt' }
}

// 만들기. 결과: { value: { title, startAt, endAt, isAllDay } } | { error }
export function parseNewSchedule(body = {}) {
  const title = parseTitle(body.title)
  if (title.error) return title
  const allDay = parseIsAllDay(body.isAllDay)
  if (allDay.error) return allDay
  const isAllDay = allDay.value ?? false
  const startAt = parseTime(body.startAt, { isAllDay, field: 'startAt' })
  if (startAt.error) return startAt
  const endAt = parseTime(body.endAt, { isAllDay, field: 'endAt' })
  if (endAt.error) return endAt
  const value = { title: title.value, startAt: startAt.value, endAt: endAt.value, isAllDay }
  const rangeError = checkRange(value)
  return rangeError ? { error: rangeError } : { value }
}

const EDITABLE = ['title', 'startAt', 'endAt', 'isAllDay']

// 보낸 시각만 그 형식으로 읽는다. isAllDay를 보내면 형식이 바뀌므로 시작 · 끝 둘 다 필요
function parseUpdatedTimes(body, isAllDay, formatChanged) {
  const times = {}
  for (const field of ['startAt', 'endAt']) {
    if (body[field] !== undefined || formatChanged) {
      const parsed = parseTime(body[field], { isAllDay, field })
      if (parsed.error) return parsed
      times[field] = parsed.value
    }
  }
  return { value: times }
}

// 보낸 제목 · isAllDay만 검사하고 나머지는 지금 값. 결과: { value: { title, isAllDay, formatChanged } } | { error }
function parseUpdatedFields(body, current) {
  const title = body.title === undefined ? { value: current.title } : parseTitle(body.title)
  if (title.error) return title
  const allDay = parseIsAllDay(body.isAllDay)
  if (allDay.error) return allDay
  return { value: { title: title.value, isAllDay: allDay.value ?? current.isAllDay, formatChanged: allDay.value !== undefined } }
}

// 수정. current: { title, startAt, endAt, isAllDay }(지금 값). 결과: { value: 바뀐 뒤 전체 값 } | { error }
export function parseScheduleUpdate(body = {}, current) {
  if (!EDITABLE.some((key) => body[key] !== undefined)) {
    return fail('empty_update', null)
  }
  const fields = parseUpdatedFields(body, current)
  if (fields.error) return fields
  const { title, isAllDay, formatChanged } = fields.value
  const times = parseUpdatedTimes(body, isAllDay, formatChanged)
  if (times.error) return times
  const value = { title, startAt: times.value.startAt ?? current.startAt, endAt: times.value.endAt ?? current.endAt, isAllDay }
  const rangeError = checkRange(value)
  return rangeError ? { error: rangeError } : { value }
}
