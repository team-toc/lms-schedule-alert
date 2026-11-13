import express from 'express'
import { createHttpLogger } from './logger.js'
import { createSessionMiddleware } from './session.js'
import { createUserRepository } from './accounts/user-repository.js'
import { createAccountService } from './accounts/account-service.js'
import { createEmailAccountService } from './accounts/email-account-service.js'
import { createPasswordHasher } from './email/password-hasher.js'
import { createLoginThrottle, LOGIN_THROTTLE_MAX_ENTRIES } from './auth/login-throttle.js'
import { createAuthRouter } from './auth/auth-routes.js'
import { createRequireUser } from './http/require-user.js'
import { createLmsRouter } from './lms/lms-routes.js'
import { createCalendarRouter } from './calendar/calendar-routes.js'
import { createNotificationRouter } from './notifications/notification-routes.js'

const HTTP_NOT_FOUND = 404
const HTTP_INTERNAL_ERROR = 500

// express.json()(body-parser)이 본문을 읽다 실패할 때 붙이는 err.type → 응답. 클라이언트 잘못이라 4xx로 돌려준다.
// 표에 없는 type은 처리하지 못한 에러로 보고 500을 돌려준다.
const BODY_ERROR_RESPONSES = new Map([
  ['entity.parse.failed', { status: 400, error: 'invalid_json', message: '요청 본문이 올바른 JSON이 아닙니다.' }],
  ['entity.too.large', { status: 413, error: 'payload_too_large', message: '요청 본문이 너무 큽니다. 최대 100KB까지 보낼 수 있습니다.' }],
  ['charset.unsupported', { status: 415, error: 'unsupported_charset', message: '지원하지 않는 문자셋입니다. UTF-8로 보내 주세요.' }],
  ['encoding.unsupported', { status: 415, error: 'unsupported_encoding', message: '지원하지 않는 Content-Encoding입니다.' }],
])
// nginx 한 단계 뒤에 있으므로 바로 앞 프록시 하나만 신뢰한다
const TRUSTED_PROXY_HOPS = 1

// 계정 로직(소셜 · 이메일)과 이메일 로그인 실패 횟수 제한을 만든다. 테스트는 저장소 · 해시 · 제한기를 바꿔 끼운다.
// dummyPasswordHash(없는 이메일용 가짜 해시)는 서버 시작 시 한 번 만들어 넘긴다 (index.js).
function createAuthServices(deps) {
  const { config, logger, pool, userRepository, passwordHasher, loginThrottle, dummyPasswordHash } = deps
  const repository = userRepository ?? createUserRepository(pool, { logger })
  return {
    accountService: createAccountService({ userRepository: repository }),
    emailAccountService: createEmailAccountService({
      userRepository: repository,
      passwordHasher: passwordHasher ?? createPasswordHasher(),
      dummyPasswordHash,
    }),
    loginThrottle:
      loginThrottle ??
      createLoginThrottle({ ...config.loginThrottle, maxEntries: LOGIN_THROTTLE_MAX_ENTRIES, now: Date.now, logger }),
  }
}

// CORS는 열지 않는다. 프론트는 같은 출처(운영: nginx, 개발: Vite 프록시)로 /api를 호출한다.
export function createApp(deps) {
  const { config, logger, kakaoClient, googleClient, sessionStore, lmsServices } = deps
  const app = express()
  if (config.trustProxy) {
    // X-Forwarded-Proto를 믿어 req.secure를 판단해야 프록시 뒤에서 Secure 쿠키가 발급된다
    app.set('trust proxy', TRUSTED_PROXY_HOPS)
  }

  const { accountService, emailAccountService, loginThrottle } = createAuthServices(deps)

  app.use(createHttpLogger(logger))
  app.use(express.json())
  app.use(createSessionMiddleware({ config, store: sessionStore }))

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() })
  })
  app.use('/api/auth', createAuthRouter({ config, kakaoClient, googleClient, accountService, emailAccountService, loginThrottle }))
  // Canvas 연동 · 캘린더 · 알림은 로그인한 사용자만. 경로 전체에 먼저 걸어, 로그인 전에는 어떤 하위 경로든 401 (ADR 0008 · 0009)
  app.use(['/api/lms', '/api/calendar', '/api/notifications'], createRequireUser({ accountService }))
  app.use('/api/lms', createLmsRouter(lmsServices))
  app.use('/api/calendar', createCalendarRouter(lmsServices))
  app.use('/api', createNotificationRouter(lmsServices))
  app.use('/api', respondNotFound)

  app.use(handleUnexpectedError)
  return app
}

// /api 아래에서 매칭되는 라우트가 없을 때. 없는 경로와 잘못된 메서드를 나누지 않고 404로 통일한다(405 없음).
function respondNotFound(req, res) {
  res.status(HTTP_NOT_FOUND).json({ error: 'not_found', message: '요청한 API를 찾을 수 없습니다.' })
}

// 요청 본문 오류는 표대로 4xx, 그 밖의 처리하지 못한 에러는 내부 내용을 숨기고 요청 ID만 돌려준다
function handleUnexpectedError(err, req, res, next) {
  const bodyError = BODY_ERROR_RESPONSES.get(err.type)
  if (bodyError && !res.headersSent) {
    // 클라이언트 잘못이라 경고로만 남긴다. 본문 내용은 남기지 않는다.
    req.log.warn({ event: 'request_body_rejected', reason: bodyError.error }, 'request body rejected')
    return res.status(bodyError.status).json({ error: bodyError.error, message: bodyError.message })
  }
  req.log.error({ err: { name: err.name, code: err.code } }, 'unhandled error')
  if (res.headersSent) {
    return next(err)
  }
  res.status(HTTP_INTERNAL_ERROR).json({ error: 'internal_error', message: '서버 오류가 발생했습니다.', requestId: req.id })
}
