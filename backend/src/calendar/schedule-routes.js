// /api/calendar/schedules 라우트 (ADR 0010). 로그인 확인은 app.js에서 /api/calendar 전체에 먼저 건다(req.user).
import express from 'express'
import { asyncRoute } from '../auth/async-route.js'
import { positiveId } from '../notifications/notification-query.js'
import { SCHEDULE_VALIDATION_MESSAGES } from './schedule-input.js'

const HTTP_CREATED = 201
const HTTP_NO_CONTENT = 204
const FAILURE_MESSAGES = {
  ...SCHEDULE_VALIDATION_MESSAGES,
  schedule_not_found: '일정을 찾을 수 없습니다.',
  schedule_read_only: '가져온 캘린더(iCloud 등)의 일정은 앱에서 바꿀 수 없습니다. 원래 캘린더에서 바꿔 주세요.',
}

function sendFailure(res, { status, error, field }) {
  const body = { error, message: FAILURE_MESSAGES[error] }
  if (field) {
    body.field = field
  }
  return res.status(status).json(body)
}

// 형식이 틀린 id(숫자 아님 · 0 · 음수 · 너무 큼)는 null → 서비스가 404로 돌려준다
const idOf = (req) => positiveId(req.params.id)

// /api/calendar에 붙인다(만들기 경로가 끝 슬래시 없는 /api/calendar/schedules가 되게)
export function createScheduleRouter({ scheduleService }) {
  const router = express.Router()
  router.post(
    '/schedules',
    asyncRoute(async (req, res) => {
      const { schedule, failure } = await scheduleService.create(req.user.id, req.body)
      return failure ? sendFailure(res, failure) : res.status(HTTP_CREATED).json(schedule)
    }),
  )
  router.patch(
    '/schedules/:id',
    asyncRoute(async (req, res) => {
      const { schedule, failure } = await scheduleService.update(req.user.id, idOf(req), req.body)
      return failure ? sendFailure(res, failure) : res.json(schedule)
    }),
  )
  router.delete(
    '/schedules/:id',
    asyncRoute(async (req, res) => {
      const { failure } = await scheduleService.remove(req.user.id, idOf(req))
      return failure ? sendFailure(res, failure) : res.status(HTTP_NO_CONTENT).end()
    }),
  )
  return router
}
