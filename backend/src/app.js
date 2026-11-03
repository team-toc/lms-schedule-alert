import express from 'express'
import cors from 'cors'
import { createHttpLogger } from './logger.js'

const HTTP_INTERNAL_ERROR = 500

export function createApp({ config, logger }) {
  const app = express()
  if (config.isProduction) {
    // nginx 뒤에서 req.secure 판단(Secure 쿠키)을 위해 필요
    app.set('trust proxy', 1)
  }

  app.use(createHttpLogger(logger))
  app.use(cors({ origin: config.frontendUrl, credentials: true }))
  app.use(express.json())

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() })
  })

  app.use(handleUnexpectedError)
  return app
}

// 처리하지 못한 에러는 내부 내용을 숨기고 요청 ID만 돌려준다
function handleUnexpectedError(err, req, res, next) {
  req.log.error({ err: { name: err.name, message: err.message } }, 'unhandled error')
  if (res.headersSent) {
    return next(err)
  }
  res.status(HTTP_INTERNAL_ERROR).json({ error: 'internal_error', message: '서버 오류가 발생했습니다.', requestId: req.id })
}
