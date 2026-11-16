// /api/calendar/* 조회 라우트 (ADR 0008 · 0010). 로그인 확인은 app.js에서 이 경로 전체에 먼저 건다(req.user).
// events: 과제 마감 + 앱 일정 + 외부(iCloud) 일정. 기존 과제 항목 필드는 그대로, 일정 항목은 source로 구분해 추가만.
// conflicts: 겹치는 일정 쌍. 기간 검사(시간대 필수 · [from, to) · 최대 92일)는 둘이 같다.
import express from 'express'
import { asyncRoute } from '../auth/async-route.js'
import { validateCalendarRange, CALENDAR_VALIDATION_MESSAGES } from './calendar-range.js'
import { toScheduleItem } from './schedule-item.js'
import { findConflicts } from './conflicts.js'

const HTTP_BAD_REQUEST = 400
// 같은 시각이면 과제 → 앱 일정 → 외부 일정 → id 순 (항상 같은 순서)
const SOURCE_ORDER = { assignment: 0, app: 1, icloud: 2, google: 3, kakao: 4 }
const timeOf = (event) => event.dueAt ?? event.startAt

function byTimeThenSource(x, y) {
  return timeOf(x).localeCompare(timeOf(y)) || SOURCE_ORDER[x.source] - SOURCE_ORDER[y.source] || x.id - y.id
}

// 결과: { value: { from, to } } 이면 진행, 아니면 400을 보냈다
function rangeOrReject(req, res) {
  const { value, error } = validateCalendarRange(req.query)
  if (error) {
    res.status(HTTP_BAD_REQUEST).json({ error: error.code, field: error.field, message: CALENDAR_VALIDATION_MESSAGES[error.code] })
    return null
  }
  return value
}

function listEvents({ calendarRepository, scheduleQueries }) {
  return async (req, res) => {
    const range = rangeOrReject(req, res)
    if (!range) return undefined
    const [assignments, schedules] = await Promise.all([
      calendarRepository.listAssignmentEvents(req.user.id, range),
      scheduleQueries.listInRange(req.user.id, range),
    ])
    const events = [...assignments, ...schedules.map(toScheduleItem)].sort(byTimeThenSource)
    return res.json({ from: range.from.toISOString(), to: range.to.toISOString(), events })
  }
}

function listConflicts({ scheduleQueries }) {
  return async (req, res) => {
    const range = rangeOrReject(req, res)
    if (!range) return undefined
    const { conflicts, truncated } = findConflicts(await scheduleQueries.listConflictCandidates(req.user.id, range))
    return res.json({ from: range.from.toISOString(), to: range.to.toISOString(), conflicts, truncated })
  }
}

export function createCalendarRouter({ calendarRepository, scheduleQueries }) {
  const router = express.Router()
  router.get('/events', asyncRoute(listEvents({ calendarRepository, scheduleQueries })))
  router.get('/conflicts', asyncRoute(listConflicts({ scheduleQueries })))
  return router
}
