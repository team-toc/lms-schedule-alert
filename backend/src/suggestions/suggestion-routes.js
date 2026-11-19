// /api/suggestions 라우트 (ADR 0011). /api에 붙인다(목록 경로가 끝 슬래시 없는 /api/suggestions가 되게). 로그인 확인은 app.js에서 먼저 건다(req.user).
import express from 'express'
import { asyncRoute } from '../auth/async-route.js'
import { positiveId } from '../notifications/notification-query.js'
import { SCHEDULE_VALIDATION_MESSAGES } from '../calendar/schedule-input.js'
import { SUGGESTION_QUERY_MESSAGES } from './suggestion-query.js'

const HTTP_CREATED = 201
const HTTP_NO_CONTENT = 204
const FAILURE_MESSAGES = {
  ...SCHEDULE_VALIDATION_MESSAGES,
  ...SUGGESTION_QUERY_MESSAGES,
  suggestion_not_found: '제안을 찾을 수 없습니다.',
  suggestion_already_decided: '이미 수락하거나 거절한 제안입니다.',
  suggestion_expired: '날짜가 지난 제안이라 일정으로 만들 수 없습니다. 거절만 할 수 있습니다.',
}

function sendFailure(res, { status, error, field }) {
  const body = { error, message: FAILURE_MESSAGES[error] }
  if (field) {
    body.field = field
  }
  return res.status(status).json(body)
}

export function createSuggestionRouter({ suggestionService }) {
  const router = express.Router()
  router.get(
    '/suggestions',
    asyncRoute(async (req, res) => {
      const { failure, ...page } = await suggestionService.list(req.user.id, req.query)
      return failure ? sendFailure(res, failure) : res.json(page)
    }),
  )
  router.post(
    '/suggestions/:id/accept',
    asyncRoute(async (req, res) => {
      const { failure, ...created } = await suggestionService.accept(req.user.id, positiveId(req.params.id), req.body)
      return failure ? sendFailure(res, failure) : res.status(HTTP_CREATED).json(created)
    }),
  )
  router.post(
    '/suggestions/:id/reject',
    asyncRoute(async (req, res) => {
      const { failure } = await suggestionService.reject(req.user.id, positiveId(req.params.id))
      return failure ? sendFailure(res, failure) : res.status(HTTP_NO_CONTENT).end()
    }),
  )
  return router
}
