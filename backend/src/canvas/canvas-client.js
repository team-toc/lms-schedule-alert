// Canvas REST API 호출만 담당하는 경계 레이어 (ADR 0008).
// 토큰은 Authorization: Bearer 헤더로만 보낸다(URL에 넣지 않음). 토큰 · Canvas 응답 본문은 에러에 넣지 않는다.
// 목록은 Link 헤더 rel="next"를 끝까지 따라가 전부 모은 뒤 돌려준다. 중간에 실패하면 일부도 돌려주지 않는다.
// HTTP 리다이렉트는 따라가지 않는다(redirect: 'manual'): 따라가면 Authorization 헤더가 Location 쪽으로 갈 수 있다.
const REQUEST_TIMEOUT_MS = 10000
const MAX_PAGES = 50
const PER_PAGE = 100
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_TOO_MANY_REQUESTS = 429
// 문서는 429지만 문구가 "Forbidden"이라, 403 + 이 문구도 요청 제한으로 본다 (ADR 0008)
const RATE_LIMIT_TEXT = /Rate Limit Exceeded/i
const NEXT_LINK = /^\s*<([^>]*)>\s*;\s*rel="?next"?\s*$/i

export const CANVAS_ERRORS = {
  unauthorized: 'canvas_unauthorized',
  forbidden: 'canvas_forbidden',
  rateLimited: 'canvas_rate_limited',
  unavailable: 'canvas_unavailable',
  timeout: 'canvas_timeout',
  tooManyPages: 'canvas_too_many_pages',
  badLink: 'canvas_bad_link',
  unexpectedRedirect: 'canvas_unexpected_redirect',
}
const HTTP_REDIRECT_MIN = 300
const HTTP_REDIRECT_MAX = 399

export class CanvasApiError extends Error {
  // code: CANVAS_ERRORS 값, status: HTTP 상태(응답이 없으면 null), path: 쿼리 없는 경로
  constructor(code, { status = null, path, cause } = {}) {
    super(`Canvas API 요청 실패: ${code}${status ? ` (HTTP ${status})` : ''} ${path}`, { cause })
    this.name = 'CanvasApiError'
    this.code = code
    this.status = status
    this.path = path
  }
}

async function readTextSafely(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

// 401은 WWW-Authenticate가 있을 때만 토큰 문제(만료 · 취소), 없으면 권한 문제로 본다 (Canvas OAuth 문서)
async function failureCode(res) {
  if (res.status >= HTTP_REDIRECT_MIN && res.status <= HTTP_REDIRECT_MAX) {
    return CANVAS_ERRORS.unexpectedRedirect
  }
  if (res.status === HTTP_UNAUTHORIZED) {
    return res.headers.has('www-authenticate') ? CANVAS_ERRORS.unauthorized : CANVAS_ERRORS.forbidden
  }
  if (res.status === HTTP_TOO_MANY_REQUESTS) {
    return CANVAS_ERRORS.rateLimited
  }
  if (res.status === HTTP_FORBIDDEN) {
    return RATE_LIMIT_TEXT.test(await readTextSafely(res)) ? CANVAS_ERRORS.rateLimited : CANVAS_ERRORS.forbidden
  }
  return CANVAS_ERRORS.unavailable
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError'
}

// 요청 하나. 성공하면 { body(JSON), res }
async function requestJson({ fetchFn, timeoutMs }, url, token) {
  const path = url.pathname
  let res
  try {
    res = await fetchFn(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new CanvasApiError(isTimeout(err) ? CANVAS_ERRORS.timeout : CANVAS_ERRORS.unavailable, { path, cause: err })
  }
  if (!res.ok) {
    throw new CanvasApiError(await failureCode(res), { status: res.status, path })
  }
  try {
    return { body: await res.json(), res }
  } catch {
    throw new CanvasApiError(CANVAS_ERRORS.unavailable, { status: res.status, path })
  }
}

// rel="next" URL은 그대로(불투명하게) 쓴다. 다른 출처면 토큰을 보내지 않고 실패한다.
function nextPageUrl(linkHeader, { baseOrigin, path }) {
  const next = (linkHeader ?? '')
    .split(',')
    .map((part) => part.match(NEXT_LINK))
    .find(Boolean)
  if (!next) {
    return null
  }
  let url
  try {
    url = new URL(next[1])
  } catch {
    throw new CanvasApiError(CANVAS_ERRORS.badLink, { path })
  }
  if (url.origin !== baseOrigin) {
    throw new CanvasApiError(CANVAS_ERRORS.badLink, { path })
  }
  return url
}

function buildCanvasUrl(baseOrigin, path, params = {}) {
  const url = new URL(path, baseOrigin)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value)
  }
  return url
}

export function createCanvasClient({ baseUrl, fetchFn = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS, maxPages = MAX_PAGES }) {
  const baseOrigin = new URL(baseUrl).origin
  const deps = { fetchFn, timeoutMs }
  const buildUrl = (path, params) => buildCanvasUrl(baseOrigin, path, params)

  async function listAll(path, params, token) {
    const items = []
    let url = buildUrl(path, { ...params, per_page: PER_PAGE })
    for (let page = 1; url; page += 1) {
      if (page > maxPages) {
        throw new CanvasApiError(CANVAS_ERRORS.tooManyPages, { path })
      }
      const { body, res } = await requestJson(deps, url, token)
      if (!Array.isArray(body)) {
        throw new CanvasApiError(CANVAS_ERRORS.unavailable, { status: res.status, path })
      }
      items.push(...body)
      url = nextPageUrl(res.headers.get('link'), { baseOrigin, path })
    }
    return items
  }

  // 토큰 확인용. 토큰 주인의 Canvas 사용자 정보
  async function getSelf(token) {
    const { body, res } = await requestJson(deps, buildUrl('/api/v1/users/self'), token)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new CanvasApiError(CANVAS_ERRORS.unavailable, { status: res.status, path: '/api/v1/users/self' })
    }
    return body
  }

  return {
    getSelf,
    listActiveCourses: (token) => listAll('/api/v1/courses', { enrollment_state: 'active' }, token),
    listAssignments: (token, courseId) => listAll(`/api/v1/courses/${courseId}/assignments`, {}, token),
    // 과목마다 따로 요청한다: 한 과목 권한 문제로 여러 과목 요청 전체가 실패하지 않게 (ADR 0008)
    listAnnouncements: (token, courseId, { startDate, endDate }) =>
      listAll(
        '/api/v1/announcements',
        { 'context_codes[]': `course_${courseId}`, start_date: startDate.toISOString(), end_date: endDate.toISOString() },
        token,
      ),
  }
}
