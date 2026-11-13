// /api/calendar/* 라우트 (ADR 0008). 로그인 확인은 app.js에서 이 경로 전체에 먼저 건다(req.user).
import express from 'express'
import { asyncRoute } from '../auth/async-route.js'
import { validateCalendarRange, CALENDAR_VALIDATION_MESSAGES } from './calendar-range.js'

const HTTP_BAD_REQUEST = 400

function listEvents({ calendarRepository }) {
  return async (req, res) => {
    const { value, error } = validateCalendarRange(req.query)
    if (error) {
      return res.status(HTTP_BAD_REQUEST).json({ error: error.code, field: error.field, message: CALENDAR_VALIDATION_MESSAGES[error.code] })
    }
    const events = await calendarRepository.listAssignmentEvents(req.user.id, value)
    res.json({ from: value.from.toISOString(), to: value.to.toISOString(), events })
  }
}

export function createCalendarRouter({ calendarRepository }) {
  const router = express.Router()
  router.get('/events', asyncRoute(listEvents({ calendarRepository })))
  return router
}
