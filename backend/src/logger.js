import { randomUUID } from 'node:crypto'
import pino from 'pino'
import pinoHttp from 'pino-http'

const REQUEST_ID_HEADER = 'X-Request-Id'

export function createLogger({ level }) {
  return pino({ level })
}

// 쿼리스트링(code, state)·쿠키·헤더는 남기지 않는다. 경로와 메서드만 기록.
export function createHttpLogger(logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = randomUUID()
      res.setHeader(REQUEST_ID_HEADER, id)
      return id
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, path: req.url.split('?')[0] }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  })
}
