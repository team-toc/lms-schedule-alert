// 규칙 추출기의 시각 찾기 (ADR 0011). 날짜 뒤 구절에서 첫 시각 표현(교시 · 시각 · 범위)을 그날 0시부터의 분으로.
// 1440(= 다음 날 0시)까지 쓴다: "밤 12시" · "자정" · "24:00"은 그날의 끝(자정 마감)
const DAY_MINUTES = 24 * 60
const HALF_DAY = 12 * 60
const DEFAULT_MINUTES = 60
const AM_WORDS = new Set(['오전', '아침', '새벽'])
const PM_WORDS = new Set(['오후', '저녁', '밤'])

const TOKEN = String.raw`(?:(오전|오후|낮|저녁|밤|아침|새벽)\s*)?(?:(\d{1,2}):(\d{2})|(\d{1,2})\s*시(?![간험])(?:\s*(\d{1,2})\s*분|\s*(반))?)|(자정|정오)`
const FIRST_TOKEN = new RegExp(String.raw`(?<![\d:])(?:${TOKEN})`)
const NEXT_TOKEN = new RegExp(String.raw`^\s*(?:~|〜|-|–|부터)\s*(?:${TOKEN})`)
const PERIOD = /(?<!\d)(\d{1,2})\s*(?:[~\-–]\s*(\d{1,2})\s*)?교시/
// 구절이 시각(시각 표현 · 교시)으로 시작하는지 — 날짜 뒤 쉼표 다음 구절을 같은 일정으로 묶을지 판단(ADR 0011, 2026-11-19)
const STARTS_WITH_TIME = new RegExp(String.raw`^\s*(?:(?:${TOKEN})|\d{1,2}\s*(?:[~\-–]\s*\d{1,2}\s*)?교시)`)

export const startsWithTime = (text) => STARTS_WITH_TIME.test(text)

// 12시: 오전 · 아침 · 새벽은 0시, 밤은 그날 끝(24시), 그 밖은 정오
const TWELVE = { 오전: 0, 아침: 0, 새벽: 0, 밤: 24 }

// 오전 · 오후 없는 '시'는 1 ~ 7시 오후, 그 밖은 그대로 (ADR 0011). 낮은 1 ~ 5시 오후
function hourOf(word, hour) {
  if (hour === 12) {
    return TWELVE[word] ?? 12
  }
  if (hour === 0 || hour > 12) {
    return hour
  }
  const afternoon = PM_WORDS.has(word) || (word === '낮' ? hour <= 5 : !AM_WORDS.has(word) && hour <= 7)
  return afternoon ? hour + 12 : hour
}

// 14:00처럼 오전 · 오후 없는 쌍점 시각은 적힌 그대로
function clockHour(word, colonHour, hourText) {
  return colonHour !== undefined && !word ? Number(colonHour) : hourOf(word, Number(colonHour ?? hourText))
}

function minuteOf(colonMinute, minuteText, half) {
  if (half) {
    return 30
  }
  return Number(colonMinute ?? minuteText ?? 0)
}

// 정규식 조각 → { minutes, word }, 틀린 값이면 null. inherited: 범위 끝이 앞의 오전 · 오후를 따를 때
function tokenMinutes(groups, inherited) {
  const [, ownWord, colonHour, colonMinute, hourText, minuteText, half, named] = groups
  if (named) {
    return { minutes: named === '자정' ? DAY_MINUTES : HALF_DAY, word: null }
  }
  const word = ownWord ?? inherited
  const minute = minuteOf(colonMinute, minuteText, half)
  const minutes = clockHour(word, colonHour, hourText) * 60 + minute
  return minute < 60 && minutes <= DAY_MINUTES ? { minutes, word } : null
}

function rangeEnd(rest, start) {
  const next = rest.match(NEXT_TOKEN)
  const end = next && tokenMinutes(next, start.word)
  if (!end) {
    return null
  }
  const minutes = end.minutes <= start.minutes && end.minutes + HALF_DAY > start.minutes ? end.minutes + HALF_DAY : end.minutes
  return minutes > start.minutes && minutes <= DAY_MINUTES + HALF_DAY ? minutes : null
}

function clockTime(region, match) {
  const start = tokenMinutes(match)
  if (!start) {
    return null
  }
  const end = rangeEnd(region.slice(match.index + match[0].length), start)
  return { startMinutes: start.minutes, endMinutes: end ?? start.minutes + DEFAULT_MINUTES, ranged: end !== null }
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

function periodTime(match, classPeriods) {
  const from = classPeriods.get(Number(match[1]))
  const to = classPeriods.get(Number(match[2] ?? match[1]))
  if (!from || !to || toMinutes(to.end) <= toMinutes(from.start)) {
    return null
  }
  return { startMinutes: toMinutes(from.start), endMinutes: toMinutes(to.end) }
}

// → { startMinutes, endMinutes } 또는 null(하루 종일). 교시가 시간표에 없으면 하루 종일.
// 명시 시각 뒤에 교시가 같이 있으면("1시50분(6교시)") 명시 시각이 시작, 범위를 안 적었고 그 교시 끝이 시작보다 뒤면 끝 = 교시 끝(ADR 0011)
// 명시 시각(범위 없음) + 뒤따르는 교시 → 끝을 교시 끝으로(교시 끝이 시작보다 뒤일 때만, 아니면 기본 1시간 그대로)
function withLessonEnd(time, period, classPeriods) {
  const lesson = time.ranged || !period ? null : periodTime(period, classPeriods)
  const endMinutes = lesson && lesson.endMinutes > time.startMinutes ? lesson.endMinutes : time.endMinutes
  return { startMinutes: time.startMinutes, endMinutes }
}

export function findTime(region, classPeriods) {
  const period = region.match(PERIOD)
  const clock = region.match(FIRST_TOKEN)
  if (period && (!clock || period.index <= clock.index)) {
    return periodTime(period, classPeriods)
  }
  const time = clock ? clockTime(region, clock) : null
  return time ? withLessonEnd(time, period, classPeriods) : null
}
