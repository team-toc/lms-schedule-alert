// /api/calendar/links/* 라우트 (ADR 0010). 로그인 확인은 app.js에서 /api/calendar 전체에 먼저 건다(req.user).
// 요청 본문(링크)은 로그에 남기지 않는다(pino-http는 경로만). 응답에도 링크 관련 칸이 없다.
import express from 'express'
import { asyncRoute } from '../auth/async-route.js'
import { positiveId } from '../notifications/notification-query.js'

const HTTP_ACCEPTED = 202
const HTTP_NO_CONTENT = 204
const MESSAGES = {
  missing_url: '공개 캘린더 링크(url)를 넣어 주세요.',
  url_too_long: '링크가 너무 깁니다.',
  invalid_url: '링크 형식이 틀렸습니다. iPhone · Mac 캘린더의 "공개 캘린더" 링크(webcal://…)를 그대로 붙여 넣어 주세요.',
  insecure_url: 'http 링크는 받지 않습니다. webcal:// 또는 https:// 링크를 넣어 주세요.',
  host_not_allowed: 'iCloud 공개 캘린더 링크(icloud.com)만 등록할 수 있습니다.',
  icloud_link_invalid: 'iCloud가 이 링크를 찾지 못했습니다. 공개 캘린더가 켜져 있는지, 링크를 다시 복사했는지 확인해 주세요.',
  icloud_not_calendar: '이 링크는 캘린더가 아닙니다.',
  icloud_parse_failed: '캘린더 내용을 읽을 수 없습니다.',
  icloud_redirect_rejected: 'iCloud가 아닌 곳으로 이동하는 링크는 받지 않습니다.',
  icloud_too_many_redirects: 'iCloud가 링크를 너무 여러 번 옮겼습니다. 잠시 후 다시 시도해 주세요.',
  icloud_too_large: '캘린더가 너무 큽니다(최대 5MB).',
  icloud_too_many_events: '캘린더 일정이 너무 많습니다(최대 5000개).',
  icloud_url_not_allowed: 'iCloud 공개 캘린더 링크만 등록할 수 있습니다.',
  icloud_unavailable: 'iCloud에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  icloud_rate_limited: 'iCloud 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.',
  icloud_timeout: 'iCloud 응답이 늦습니다. 잠시 후 다시 시도해 주세요.',
  calendar_link_already_registered: '이미 등록한 캘린더입니다.',
  calendar_link_limit_reached: '캘린더는 5개까지 연결할 수 있습니다. 쓰지 않는 연결을 지운 뒤 다시 시도해 주세요.',
  calendar_link_not_found: '캘린더 연결을 찾을 수 없습니다.',
  calendar_link_invalid: '이 링크는 더 이상 쓸 수 없습니다. 연결을 지우고 새 링크로 다시 등록해 주세요.',
  sync_too_frequent: '방금 동기화했습니다. 잠시 후 다시 시도해 주세요.',
}

function sendFailure(res, { status, error, field, retryAfterSeconds }) {
  if (retryAfterSeconds !== undefined) {
    res.set('Retry-After', String(retryAfterSeconds))
  }
  const body = { error, message: MESSAGES[error] }
  if (field) {
    body.field = field
  }
  return res.status(status).json(body)
}

const idOf = (req) => positiveId(req.params.id)

// /api/calendar에 붙인다
export function createCalendarLinkRouter({ calendarLinkService }) {
  const router = express.Router()
  router.post(
    '/links/icloud',
    asyncRoute(async (req, res) => {
      const { link, failure } = await calendarLinkService.registerIcloud(req.user.id, req.body?.url)
      return failure ? sendFailure(res, failure) : res.status(HTTP_ACCEPTED).json(link)
    }),
  )
  router.get(
    '/links',
    asyncRoute(async (req, res) => res.json(await calendarLinkService.list(req.user.id))),
  )
  router.delete(
    '/links/:id',
    asyncRoute(async (req, res) => {
      const { failure } = await calendarLinkService.remove(req.user.id, idOf(req))
      return failure ? sendFailure(res, failure) : res.status(HTTP_NO_CONTENT).end()
    }),
  )
  router.post(
    '/links/:id/sync',
    asyncRoute(async (req, res) => {
      const { status, failure } = await calendarLinkService.requestSync(req.user.id, idOf(req))
      return failure ? sendFailure(res, failure) : res.status(HTTP_ACCEPTED).json({ syncStatus: status })
    }),
  )
  return router
}
