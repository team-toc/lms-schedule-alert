// ICS(iCalendar) → NormalizedEvent[] (ADR 0010). 파서는 node-ical(버전 고정), 반복은 창 안의 회차만 만든다.
// - 시각은 모두 UTC Date. 떠 있는 시각(시간대 없음)은 서울로, 하루 종일은 서울 자정 ~ 다음 자정으로(서버 시간대와 무관)
// - 취소(STATUS:CANCELLED, 취소된 회차)는 뺀다. 시작이 없거나 · UID가 없거나 · 끝 < 시작인 항목은 그것만 건너뛰고 센다
// - 제목만 남긴다(255 코드포인트, 없으면 '(제목 없음)'). 설명 · 위치 · 참석자는 읽지 않는다
// - 깨진 ICS · 창 안 회차가 상한을 넘으면 IcsParseError(일부만 돌려주지 않음)
import ical from 'node-ical'
import { APP_TIME_ZONE, seoulMidnight } from './seoul-time.js'

export const DEFAULT_MAX_EVENTS = 5000
const MAX_TITLE_CODE_POINTS = 255
const UNTITLED = '(제목 없음)'
const DAY_MS = 24 * 60 * 60 * 1000

export const ICS_ERRORS = {
  parseFailed: 'icloud_parse_failed',
  tooManyEvents: 'icloud_too_many_events',
}

export class IcsParseError extends Error {
  constructor(code) {
    super(`ICS 처리 실패: ${code}`)
    this.name = 'IcsParseError'
    this.code = code
  }
}

const TIME_PROPERTY = /^(DTSTART|DTEND|EXDATE|RECURRENCE-ID|RDATE)((?:;[^:]*)?):(.*)$/i
const FLOATING_VALUE = /^\d{8}T\d{6}$/

// 떠 있는 시각(Z도 TZID도 없는 DATE-TIME)에 TZID=Asia/Seoul을 붙인다. node-ical은 그런 값을 서버 시간대로 읽기 때문
function pinFloatingTimes(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  return unfolded
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(TIME_PROPERTY)
      if (!match || /;TZID=/i.test(match[2]) || /VALUE=DATE(?:;|$)/i.test(match[2])) {
        return line
      }
      const values = match[3].split(',')
      return values.every((value) => FLOATING_VALUE.test(value)) ? `${match[1]}${match[2]};TZID=${APP_TIME_ZONE}:${match[3]}` : line
    })
    .join('\r\n')
}

function parseCalendar(text) {
  if (typeof text !== 'string' || !/^BEGIN:VCALENDAR\s*$/m.test(text) || !/^END:VCALENDAR\s*$/m.test(text)) {
    throw new IcsParseError(ICS_ERRORS.parseFailed)
  }
  try {
    return ical.sync.parseICS(pinFloatingTimes(text))
  } catch {
    throw new IcsParseError(ICS_ERRORS.parseFailed)
  }
}

function titleOf(summary) {
  const raw = typeof summary === 'object' && summary !== null ? summary.val : summary
  const title = typeof raw === 'string' ? raw.trim() : ''
  return title === '' ? UNTITLED : [...title].slice(0, MAX_TITLE_CODE_POINTS).join('')
}

// node-ical은 날짜(DATE)를 서버 현지 자정으로 만든다 → 현지 날짜를 꺼내 서울 자정으로 다시 계산
const localDateOf = (date) => ({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() })
const dateKey = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

// node-ical의 Date에는 tz 같은 속성이 붙어 있어 순수 Date로 복사해 내보낸다
const plainDate = (date) => new Date(date.getTime())

function instanceTimes(instance) {
  if (!instance.isFullDay) {
    return { startAt: plainDate(instance.start), endAt: plainDate(instance.end ?? instance.start), isAllDay: false }
  }
  const startAt = seoulMidnight(localDateOf(instance.start))
  const endAt = instance.end ? seoulMidnight(localDateOf(instance.end)) : new Date(startAt.getTime() + DAY_MS)
  return { startAt, endAt, isAllDay: true }
}

// 회차 키: 반복 아닌 일정은 UID, 반복 회차는 UID | 원래 시작(바뀐 회차는 RECURRENCE-ID). 하루 종일은 날짜로(서버 시간대와 무관)
function occurrenceKey(uid, instance) {
  if (!instance.isRecurring && !instance.event?.recurrenceid) {
    return uid
  }
  const original = instance.isOverride && instance.event?.recurrenceid ? instance.event.recurrenceid : instance.start
  return `${uid}|${instance.isFullDay ? dateKey(localDateOf(original)) : original.toISOString()}`
}

const statusOf = (raw) => (String(raw ?? '').toUpperCase() === 'TENTATIVE' ? 'tentative' : 'confirmed')
const isCancelled = (raw) => String(raw ?? '').toUpperCase() === 'CANCELLED'

// 창과 겹치는가: 구간은 end > 창 시작 && start < 창 끝, 길이 0은 창 시작 ≤ 시각 < 창 끝
function inWindow({ startAt, endAt }, { windowStart, windowEnd }) {
  if (startAt >= windowEnd) return false
  return endAt > windowStart || (startAt.getTime() === endAt.getTime() && startAt >= windowStart)
}

// 회차 하나 → NormalizedEvent | 'skip'(끝 < 시작) | null(취소 · 창 밖)
function toNormalized(event, instance, window) {
  const source = instance.event ?? event
  if (isCancelled(source.status)) {
    return null
  }
  const times = instanceTimes(instance)
  if (times.endAt < times.startAt) {
    return 'skip'
  }
  if (!inWindow(times, window)) {
    return null
  }
  return {
    sourceType: 'icloud',
    externalId: occurrenceKey(event.uid, instance),
    title: titleOf(instance.summary ?? source.summary),
    ...times,
    status: statusOf(source.status),
    updatedAt: source.lastmodified instanceof Date ? plainDate(source.lastmodified) : null,
  }
}

const hasStart = (event) => event.start instanceof Date && !Number.isNaN(event.start.getTime())

// 한 VEVENT(반복이면 창 안 회차들) → 결과 목록에 넣는다. 건너뛴 수를 돌려준다
function collectEvent(event, window, out) {
  if (!event.uid || !hasStart(event)) {
    return 1
  }
  if (isCancelled(event.status)) {
    return 0
  }
  let skipped = 0
  for (const instance of ical.expandRecurringEvent(event, { from: window.windowStart, to: window.windowEnd, expandOngoing: true })) {
    const normalized = toNormalized(event, instance, window)
    if (normalized === 'skip') {
      skipped += 1
    } else if (normalized) {
      out.push(normalized)
    }
    if (out.length > window.maxEvents) {
      throw new IcsParseError(ICS_ERRORS.tooManyEvents)
    }
  }
  return skipped
}

// 결과: { events: NormalizedEvent[](시작 → externalId 순), skipped }
export function parseIcsEvents(text, { windowStart, windowEnd, maxEvents = DEFAULT_MAX_EVENTS }) {
  const components = parseCalendar(text)
  const window = { windowStart, windowEnd, maxEvents }
  const events = []
  let skipped = 0
  for (const component of Object.values(components)) {
    if (component?.type === 'VEVENT') {
      skipped += collectEvent(component, window, events)
    }
  }
  events.sort((a, b) => a.startAt - b.startAt || (a.externalId < b.externalId ? -1 : 1))
  return { events, skipped }
}
