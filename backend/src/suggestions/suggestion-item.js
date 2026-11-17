// 제안 응답 모양 (ADR 0011). 시각은 UTC ISO, 하루 종일이면 서울 날짜(끝은 미포함)도. 공지 본문은 주지 않는다(맥락만).
// status는 계산한 값(pending이면서 지난 것은 expired). scheduleId는 만든 일정이 지워졌으면 null
import { seoulDate } from '../calendar/seoul-time.js'
import { isPast } from './suggestion-policy.js'

export const isExpired = (row, now) => row.status === 'pending' && isPast({ startAt: row.start_at, endAt: row.end_at, isAllDay: Boolean(row.is_all_day) }, now)

export function toSuggestionItem(row, now) {
  const isAllDay = Boolean(row.is_all_day)
  return {
    id: row.id,
    kind: row.kind,
    status: isExpired(row, now) ? 'expired' : row.status,
    courseName: row.course_name,
    announcementTitle: row.announcement_title,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    isAllDay,
    startDate: isAllDay ? seoulDate(row.start_at) : null,
    endDate: isAllDay ? seoulDate(row.end_at) : null,
    context: row.context,
    url: row.html_url,
    scheduleId: row.live_schedule_id ?? null,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  }
}
