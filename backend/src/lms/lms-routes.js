// /api/lms/* 라우트 (ADR 0008). 로그인 확인은 app.js에서 이 경로 전체에 먼저 건다(req.user).
// 토큰 · 요청 본문은 로그에 남기지 않는다. 사건 이름 · userId · 고정 코드만.
import express from 'express'
import { asyncRoute } from '../auth/async-route.js'
import { validateTokenInput, TOKEN_VALIDATION_MESSAGES } from './token-input.js'

const HTTP_ACCEPTED = 202
const HTTP_BAD_REQUEST = 400
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415
const UNSUPPORTED_MEDIA_TYPE = { error: 'unsupported_media_type', message: 'Content-Type은 application/json이어야 합니다.' }

// 폼 POST(다른 사이트에서 보낸 요청 포함)를 막기 위해 JSON만 받는다
function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(HTTP_UNSUPPORTED_MEDIA_TYPE).json(UNSUPPORTED_MEDIA_TYPE)
  }
  next()
}

function registerToken({ tokenService }) {
  return async (req, res) => {
    const userId = req.user.id
    const { value, error } = validateTokenInput(req.body)
    if (error) {
      req.log.info({ event: 'lms_token_rejected', userId, reason: error.code }, 'lms token rejected')
      return res.status(HTTP_BAD_REQUEST).json({ error: error.code, field: error.field, message: TOKEN_VALIDATION_MESSAGES[error.code] })
    }
    const result = await tokenService.registerToken(userId, value)
    if (result.failure) {
      const { status, ...body } = result.failure
      req.log.warn({ event: 'lms_token_rejected', userId, reason: body.error, canvasError: result.canvasError }, 'lms token rejected')
      return res.status(status).json(body)
    }
    req.log.info({ event: 'lms_token_registered', userId }, 'lms token registered')
    res.status(HTTP_ACCEPTED).json({ status: 'syncing' })
  }
}

export function createLmsRouter({ tokenService }) {
  const router = express.Router()
  router.post('/token', requireJson, asyncRoute(registerToken({ tokenService })))
  return router
}
