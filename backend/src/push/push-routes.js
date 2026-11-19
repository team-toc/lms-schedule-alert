// /api/push 라우트 (ADR 0012). /api에 붙인다(경로가 끝 슬래시 없이 api.md와 맞게).
// 공개키는 로그인 없이(공개값), 구독 등록 · 해제 · 테스트 발송은 로그인한 사용자만(app.js에서 먼저 건다, req.user).
// 푸시 설정 없이 만든 앱(테스트 기본값)은 라우트는 있되 503 push_unavailable — 실제 서버는 설정이 없으면 시작하지 않는다.
import express from 'express'
import { asyncRoute } from '../auth/async-route.js'

const HTTP_ACCEPTED = 202
const HTTP_CREATED = 201
const HTTP_OK = 200
const HTTP_NO_CONTENT = 204
const HTTP_UNAVAILABLE = 503
const FAILURE_MESSAGES = {
  missing_endpoint: '구독 주소(endpoint)를 넣어 주세요.',
  invalid_endpoint: '구독 주소(endpoint) 형식이 틀렸습니다.',
  insecure_endpoint: '구독 주소(endpoint)는 https여야 합니다.',
  endpoint_too_long: '구독 주소(endpoint)가 너무 깁니다.',
  push_service_not_allowed: '지원하지 않는 푸시 서비스 주소입니다.',
  missing_keys: '구독 키(keys)를 넣어 주세요.',
  invalid_p256dh: '구독 키 p256dh 형식이 틀렸습니다.',
  invalid_auth: '구독 키 auth 형식이 틀렸습니다.',
  push_subscription_not_found: '이 브라우저의 구독을 찾을 수 없습니다.',
  push_unavailable: '푸시 알림을 쓸 수 없습니다.',
}

function sendFailure(res, { status, error, field }) {
  const body = { error, message: FAILURE_MESSAGES[error] }
  if (field) {
    body.field = field
  }
  return res.status(status).json(body)
}

const UNAVAILABLE = { status: HTTP_UNAVAILABLE, error: 'push_unavailable' }

// testRoute: 개발용 테스트 발송 라우트를 붙일지(운영이면 false → 라우트 자체가 없어 404)
export function createPushRouter({ pushServices }, { testRoute }) {
  const router = express.Router()
  router.get('/push/public-key', (req, res) => (pushServices ? res.json({ publicKey: pushServices.publicKey }) : sendFailure(res, UNAVAILABLE)))
  router.post(
    '/push/subscriptions',
    asyncRoute(async (req, res) => {
      if (!pushServices) return sendFailure(res, UNAVAILABLE)
      const { status, failure } = await pushServices.subscriptionService.register(req.user.id, req.body)
      return failure ? sendFailure(res, failure) : res.status(status === 'created' ? HTTP_CREATED : HTTP_OK).json({})
    }),
  )
  router.delete(
    '/push/subscriptions',
    asyncRoute(async (req, res) => {
      if (!pushServices) return sendFailure(res, UNAVAILABLE)
      const { failure } = await pushServices.subscriptionService.unregister(req.user.id, req.body)
      return failure ? sendFailure(res, failure) : res.status(HTTP_NO_CONTENT).end()
    }),
  )
  if (testRoute) {
    router.post(
      '/push/test',
      asyncRoute(async (req, res) => {
        if (!pushServices) return sendFailure(res, UNAVAILABLE)
        return res.status(HTTP_ACCEPTED).json({ queued: await pushServices.step.sendTest(req.user.id) })
      }),
    )
  }
  return router
}
