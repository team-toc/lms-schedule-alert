// 테스트용 iCalendar(ICS) 만들기. iCloud가 내보내는 모양(VTIMEZONE 포함, CRLF)을 흉내 낸다.
// 시각 표기: '2026-11-20T01:00:00Z'(UTC) · '2026-11-20T10:00:00'(tzid와 함께, 없으면 떠 있는 시각) · '2026-11-20'(날짜 = 하루 종일)
const CRLF = '\r\n'

const VTIMEZONES = {
  'Asia/Seoul': ['BEGIN:VTIMEZONE', 'TZID:Asia/Seoul', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:KST', 'DTSTART:19700101T000000', 'END:STANDARD', 'END:VTIMEZONE'],
  'America/New_York': [
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ],
}

const compact = (value) => value.replace(/[-:]/g, '').replace(/\.\d+/, '')

// 'DTSTART' + 값 → 'DTSTART;TZID=...:20261120T100000' 같은 한 줄
export function icsTime(name, value, tzid) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${name};VALUE=DATE:${compact(value)}`
  }
  if (value.endsWith('Z')) {
    return `${name}:${compact(value)}`
  }
  return tzid ? `${name};TZID=${tzid}:${compact(value)}` : `${name}:${compact(value)}`
}

// ICS 글자 이스케이프 (RFC 5545 TEXT)
export const icsText = (text) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')

// 값이 있는 칸만 한 줄씩 (순서는 iCloud 내보내기와 비슷하게)
function optionalLines({ summary, start, end, tzid, rrule, exdates, recurrenceId, status, duration, lastModified }) {
  return [
    summary !== undefined && `SUMMARY:${icsText(summary)}`,
    start !== undefined && icsTime('DTSTART', start, tzid),
    end !== undefined && icsTime('DTEND', end, tzid),
    duration && `DURATION:${duration}`,
    rrule && `RRULE:${rrule}`,
    ...exdates.map((exdate) => icsTime('EXDATE', exdate, tzid)),
    recurrenceId && icsTime('RECURRENCE-ID', recurrenceId, tzid),
    status && `STATUS:${status}`,
    lastModified && `LAST-MODIFIED:${compact(lastModified)}`,
  ].filter(Boolean)
}

export function vevent({ uid, exdates = [], extra = [], ...fields }) {
  return ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261101T000000Z', ...optionalLines({ ...fields, exdates }), ...extra, 'END:VEVENT'].join(CRLF)
}

export function ics(...events) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iCloud 2.0//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:테스트',
    ...VTIMEZONES['Asia/Seoul'], ...VTIMEZONES['America/New_York'],
    ...events,
    'END:VCALENDAR',
  ].join(CRLF) + CRLF
}
