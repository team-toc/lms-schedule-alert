// /api/notifications/* 라우트 (ADR 0009). 로그인 확인은 app.js에서 이 경로 전체에 먼저 건다(req.user).
// 읽음: 다른 사용자 · 없는 id · 형식이 틀린 id는 모두 같은 404(존재 여부를 드러내지 않음).
import express from 'express'
import { asyncRoute } from '../auth/async-route.js'
import { parseListQuery, positiveId, NOTIFICATION_VALIDATION_MESSAGES } from './notification-query.js'

const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404
const HTTP_NO_CONTENT = 204
const NOT_FOUND = { error: 'notification_not_found', message: '알림을 찾을 수 없습니다.' }

function listNotifications({ notificationRepository }) {
  return async (req, res) => {
    const { value, error } = parseListQuery(req.query)
    if (error) {
      return res.status(HTTP_BAD_REQUEST).json({ error: error.code, message: NOTIFICATION_VALIDATION_MESSAGES[error.code] })
    }
    res.json(await notificationRepository.list(req.user.id, value))
  }
}

function markRead({ notificationRepository }) {
  return async (req, res) => {
    const id = positiveId(req.params.id)
    if (id === null || !(await notificationRepository.markRead(req.user.id, id))) {
      return res.status(HTTP_NOT_FOUND).json(NOT_FOUND)
    }
    res.status(HTTP_NO_CONTENT).end()
  }
}

function markAllRead({ notificationRepository }) {
  return async (req, res) => {
    await notificationRepository.markAllRead(req.user.id)
    res.status(HTTP_NO_CONTENT).end()
  }
}

// /api에 붙인다(목록 경로가 끝 슬래시 없는 /api/notifications가 되게)
export function createNotificationRouter({ notificationRepository }) {
  const router = express.Router()
  router.get('/notifications', asyncRoute(listNotifications({ notificationRepository })))
  router.post('/notifications/read-all', asyncRoute(markAllRead({ notificationRepository })))
  router.post('/notifications/:id/read', asyncRoute(markRead({ notificationRepository })))
  return router
}
