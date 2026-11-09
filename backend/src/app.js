import express from 'express'
import { createHttpLogger } from './logger.js'
import { createSessionMiddleware } from './session.js'
import { createUserRepository } from './accounts/user-repository.js'
import { createAccountService } from './accounts/account-service.js'
import { createEmailAccountService } from './accounts/email-account-service.js'
import { createPasswordHasher } from './email/password-hasher.js'
import { createLoginThrottle, LOGIN_THROTTLE_MAX_ENTRIES } from './auth/login-throttle.js'
import { createAuthRouter } from './auth/auth-routes.js'

const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404
const HTTP_INTERNAL_ERROR = 500
// express.json()이 본문 JSON 파싱에 실패했을 때 붙이는 에러 type
const JSON_PARSE_ERROR_TYPE = 'entity.parse.failed'
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
  const { config, logger, kakaoClient, googleClient, sessionStore } = deps
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
  app.use('/api', respondNotFound)

  app.use(handleUnexpectedError)
  return app
}

// /api 아래에서 매칭되는 라우트가 없을 때. 없는 경로와 잘못된 메서드를 나누지 않고 404로 통일한다(405 없음).
function respondNotFound(req, res) {
  res.status(HTTP_NOT_FOUND).json({ error: 'not_found', message: '요청한 API를 찾을 수 없습니다.' })
}

// 처리하지 못한 에러는 내부 내용을 숨기고 요청 ID만 돌려준다
function handleUnexpectedError(err, req, res, next) {
  if (err.type === JSON_PARSE_ERROR_TYPE && !res.headersSent) {
    // 클라이언트 잘못이라 경고로만 남긴다. 본문 내용은 남기지 않는다.
    req.log.warn({ event: 'invalid_json' }, 'request body is not valid JSON')
    return res.status(HTTP_BAD_REQUEST).json({ error: 'invalid_json', message: '요청 본문이 올바른 JSON이 아닙니다.' })
  }
  req.log.error({ err: { name: err.name, code: err.code } }, 'unhandled error')
  if (res.headersSent) {
    return next(err)
  }
  res.status(HTTP_INTERNAL_ERROR).json({ error: 'internal_error', message: '서버 오류가 발생했습니다.', requestId: req.id })
}
