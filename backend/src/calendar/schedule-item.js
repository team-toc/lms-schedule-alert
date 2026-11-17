// 일정 응답 모양 (ADR 0010). 앱 일정 · 외부 일정 공통: 만들기 · 수정 응답과 GET /api/calendar/events의 일정 항목.
// 시각은 UTC ISO. 하루 종일이면 서울 날짜(끝은 미포함)도 준다.
import { seoulDate } from './seoul-time.js'

export function toScheduleItem(row) {
  const isAllDay = Boolean(row.is_all_day)
  return {
    source: row.source,
    id: row.id,
    calendarLinkId: row.calendar_link_id,
    title: row.title,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    isAllDay,
    startDate: isAllDay ? seoulDate(row.start_at) : null,
    endDate: isAllDay ? seoulDate(row.end_at) : null,
  }
}
