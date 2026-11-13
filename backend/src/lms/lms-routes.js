// /api/lms/* 라우트 (ADR 0008). 로그인 확인은 app.js에서 이 경로 전체에 먼저 건다(req.user).
// 토큰 · 요청 본문은 로그에 남기지 않는다. 사건 이름 · userId · 고정 코드만.
import express from 'express'
import { asyncRoute } from '../auth/async-route.js'
import { validateTokenInput, TOKEN_VALIDATION_MESSAGES } from './token-input.js'

const HTTP_ACCEPTED = 202
const HTTP_NO_CONTENT = 204
const HTTP_BAD_REQUEST = 400
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415
const UNSUPPORTED_MEDIA_TYPE = { error: 'unsupported_media_type', message: 'Content-Type은 application/json이어야 합니다.' }
const NOT_CONNECTED = { status: 404, error: 'lms_not_connected', message: 'Canvas가 연결되어 있지 않습니다. 먼저 토큰을 등록해 주세요.' }
const SYNC_FAILURES = {
  lms_not_connected: NOT_CONNECTED,
  lms_needs_reauth: { status: 409, error: 'lms_needs_reauth', message: 'Canvas 토큰이 만료되었거나 취소되었습니다. 토큰을 다시 등록해 주세요.' },
  sync_too_frequent: { status: 429, error: 'sync_too_frequent', message: '동기화는 5분에 한 번까지 요청할 수 있습니다. 잠시 후 다시 시도해 주세요.' },
}

function sendFailure(res, { status, ...body }) {
  res.status(status).json(body)
}

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

function deleteToken({ tokenService }) {
  return async (req, res) => {
    if (!(await tokenService.deleteToken(req.user.id))) {
      return sendFailure(res, NOT_CONNECTED)
    }
    req.log.info({ event: 'lms_token_deleted', userId: req.user.id }, 'lms token deleted')
    res.status(HTTP_NO_CONTENT).end()
  }
}

function getStatus({ tokenService }) {
  return async (req, res) => {
    res.json(await tokenService.getStatus(req.user.id))
  }
}

function requestSync({ manualSync }) {
  return async (req, res) => {
    const result = await manualSync.requestSync(req.user.id)
    if (result.error) {
      if (result.retryAfterSeconds) {
        res.set('Retry-After', String(result.retryAfterSeconds))
      }
      return sendFailure(res, SYNC_FAILURES[result.error])
    }
    req.log.info({ event: 'lms_sync_requested', userId: req.user.id }, 'manual lms sync requested')
    res.status(HTTP_ACCEPTED).json({ status: result.status })
  }
}

export function createLmsRouter({ tokenService, manualSync }) {
  const router = express.Router()
  router.post('/token', requireJson, asyncRoute(registerToken({ tokenService })))
  router.delete('/token', asyncRoute(deleteToken({ tokenService })))
  router.get('/status', asyncRoute(getStatus({ tokenService })))
  router.post('/sync', asyncRoute(requestSync({ manualSync })))
  return router
}
