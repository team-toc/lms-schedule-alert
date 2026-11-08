import express from 'express'
import { createHttpLogger } from './logger.js'
import { createSessionMiddleware } from './session.js'
import { createUserRepository } from './accounts/user-repository.js'
import { createAccountService } from './accounts/account-service.js'
import { createAuthRouter } from './auth/auth-routes.js'

const HTTP_BAD_REQUEST = 400
const HTTP_INTERNAL_ERROR = 500
// express.json()이 본문 JSON 파싱에 실패했을 때 붙이는 에러 type
const JSON_PARSE_ERROR_TYPE = 'entity.parse.failed'
// nginx 한 단계 뒤에 있으므로 바로 앞 프록시 하나만 신뢰한다
const TRUSTED_PROXY_HOPS = 1

// CORS는 열지 않는다. 프론트는 같은 출처(운영: nginx, 개발: Vite 프록시)로 /api를 호출한다.
export function createApp({ config, logger, pool, kakaoClient, googleClient, sessionStore, userRepository }) {
  const app = express()
  if (config.trustProxy) {
    // X-Forwarded-Proto를 믿어 req.secure를 판단해야 프록시 뒤에서 Secure 쿠키가 발급된다
    app.set('trust proxy', TRUSTED_PROXY_HOPS)
  }

  const accountService = createAccountService({
    userRepository: userRepository ?? createUserRepository(pool, { logger }),
  })

  app.use(createHttpLogger(logger))
  app.use(express.json())
  app.use(createSessionMiddleware({ config, store: sessionStore }))

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() })
  })
  app.use('/api/auth', createAuthRouter({ config, kakaoClient, googleClient, accountService }))

  app.use(handleUnexpectedError)
  return app
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
