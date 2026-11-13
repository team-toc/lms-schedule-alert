// 캘린더 기간(from · to) 검사 (ADR 0008).
// ISO 8601 날짜 + 시각 + 시간대(Z 또는 ±hh:mm)만 받는다. 시간대가 없으면 거부한다(서버가 UTC로 간주하면
// 브라우저의 현지 시각이 조용히 9시간 어긋난다). 받은 값은 UTC로 정규화한다. [from, to), 최대 92일.
export const MAX_RANGE_DAYS = 92
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_OFFSET_HOURS = 23
const MAX_OFFSET_MINUTES = 59
// 연-월-일T시:분[:초[.밀리초]](Z | ±hh:mm)
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/

export const CALENDAR_VALIDATION_MESSAGES = {
  missing_from: '조회 시작 시각(from)을 넣어 주세요.',
  missing_to: '조회 끝 시각(to)을 넣어 주세요.',
  invalid_from: 'from은 시간대가 붙은 ISO 8601 시각이어야 합니다. 예: 2026-11-01T00:00:00Z, 2026-11-01T09:00:00+09:00',
  invalid_to: 'to는 시간대가 붙은 ISO 8601 시각이어야 합니다. 예: 2026-12-01T00:00:00Z',
  invalid_range: 'to는 from보다 뒤여야 합니다.',
  range_too_long: `한 번에 ${MAX_RANGE_DAYS}일까지 조회할 수 있습니다.`,
}

// 형식뿐 아니라 실제 있는 날짜 · 시각인지(2월 30일, 13월, 24시 거부)도 본다
function isRealDateTime([, year, month, day, hour, minute, second = '0']) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)))
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second)
  )
}

function isValidOffset(match) {
  const [, , , , , , , zone, , offsetHours, offsetMinutes] = match
  return zone === 'Z' || (Number(offsetHours) <= MAX_OFFSET_HOURS && Number(offsetMinutes) <= MAX_OFFSET_MINUTES)
}

// 결과: Date | 'missing' | 'invalid'
function parseInstant(value) {
  if (value === undefined || value === '') {
    return 'missing'
  }
  const match = typeof value === 'string' ? value.match(ISO_WITH_ZONE) : null
  if (!match || !isRealDateTime(match) || !isValidOffset(match)) {
    return 'invalid'
  }
  return new Date(value)
}

// 결과: { value: { from, to } } 또는 { error: { code, field } }
export function validateCalendarRange(query) {
  const from = parseInstant(query.from)
  if (!(from instanceof Date)) {
    return { error: { code: `${from}_from`, field: 'from' } }
  }
  const to = parseInstant(query.to)
  if (!(to instanceof Date)) {
    return { error: { code: `${to}_to`, field: 'to' } }
  }
  if (from.getTime() >= to.getTime()) {
    return { error: { code: 'invalid_range', field: 'to' } }
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    return { error: { code: 'range_too_long', field: 'to' } }
  }
  return { value: { from, to } }
}
