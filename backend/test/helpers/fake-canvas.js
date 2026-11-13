// 실제 Canvas 대신 쓰는 fetch. 문서(ADR 0008)의 동작을 흉내 낸다:
// Bearer 토큰 인증(모르면 401 + WWW-Authenticate), Link 헤더 페이지(rel="next"는 불투명 URL), 공지 기간 필터.
// 서버 쪽 페이지 크기(pageSize)를 작게 둬서 per_page=100을 보내도 여러 페이지로 나뉘게 한다.
export const CANVAS_BASE_URL = 'https://canvas.test'
const DEFAULT_PAGE_SIZE = 2
const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_NOT_FOUND = 404
const ASSIGNMENTS_PATH = /^\/api\/v1\/courses\/(\d+)\/assignments$/

export function canvasResponse(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

// 실패 응답 모음 (요청 제한은 429와 403 + "Rate Limit Exceeded" 둘 다, ADR 0008)
export const canvasFailures = {
  unauthorized: () =>
    canvasResponse(HTTP_UNAUTHORIZED, { errors: [{ message: 'Invalid access token.' }] }, { 'WWW-Authenticate': 'Bearer realm="canvas-lms"' }),
  unauthorizedWithoutChallenge: () => canvasResponse(HTTP_UNAUTHORIZED, { status: 'unauthorized', errors: [{ message: 'user not authorized' }] }),
  rateLimited429: () => canvasResponse(429, '429 Forbidden (Rate Limit Exceeded)', { 'Content-Type': 'text/plain' }),
  rateLimited403: () => canvasResponse(403, '403 Forbidden (Rate Limit Exceeded)', { 'Content-Type': 'text/plain' }),
  forbidden: () => canvasResponse(403, { status: 'unauthorized', errors: [{ message: 'user not authorized to perform that action' }] }),
  serverError: () => canvasResponse(500, { errors: [{ message: 'An error occurred.' }] }),
  notJson: () => canvasResponse(HTTP_OK, '<html>maintenance</html>', { 'Content-Type': 'text/html' }),
}

export function canvasCourse(id, { name = `과목 ${id}`, ...rest } = {}) {
  return { id, name, course_code: `C${id}`, workflow_state: 'available', ...rest }
}

export function canvasAssignment(courseId, id, { name = `과제 ${id}`, dueAt = null, published = true, htmlUrl, ...rest } = {}) {
  return {
    id,
    course_id: courseId,
    name,
    due_at: dueAt,
    published,
    html_url: htmlUrl === undefined ? `${CANVAS_BASE_URL}/courses/${courseId}/assignments/${id}` : htmlUrl,
    ...rest,
  }
}

export function canvasAnnouncement(courseId, id, { title = `공지 ${id}`, message = '<p>공지 본문</p>', postedAt, htmlUrl, ...rest } = {}) {
  return {
    id,
    title,
    message,
    posted_at: postedAt,
    html_url: htmlUrl === undefined ? `${CANVAS_BASE_URL}/courses/${courseId}/discussion_topics/${id}` : htmlUrl,
    context_code: `course_${courseId}`,
    ...rest,
  }
}

function bearerToken(headers) {
  const value = new Headers(headers).get('authorization') ?? ''
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : null
}

function paginate(url, items, pageSize) {
  const page = Number(url.searchParams.get('page') ?? '1')
  const size = Math.min(Number(url.searchParams.get('per_page') ?? '10'), pageSize)
  const slice = items.slice((page - 1) * size, page * size)
  const link = (n) => {
    const next = new URL(url)
    next.searchParams.set('page', String(n))
    next.searchParams.set('opaque', `cursor${n}`)
    return next.toString()
  }
  const rels = [`<${link(page)}>; rel="current"`, `<${link(1)}>; rel="first"`]
  if (page * size < items.length) {
    rels.push(`<${link(page + 1)}>; rel="next"`)
  }
  return canvasResponse(HTTP_OK, slice, { Link: rels.join(',') })
}

function announcementsFor(account, url) {
  const codes = url.searchParams.getAll('context_codes[]')
  const start = new Date(url.searchParams.get('start_date'))
  const end = new Date(url.searchParams.get('end_date'))
  return codes
    .flatMap((code) => account.announcements.get(Number(code.replace('course_', ''))) ?? [])
    .filter((a) => new Date(a.posted_at) >= start && new Date(a.posted_at) <= end)
}

function route(account, url) {
  if (url.pathname === '/api/v1/users/self') {
    return canvasResponse(HTTP_OK, account.self)
  }
  if (url.pathname === '/api/v1/courses') {
    if (url.searchParams.get('enrollment_state') !== 'active') {
      return canvasResponse(HTTP_BAD_REQUEST, { errors: [{ message: 'fake canvas: enrollment_state=active 필요' }] })
    }
    return account.courses
  }
  const assignments = url.pathname.match(ASSIGNMENTS_PATH)
  if (assignments) {
    return account.assignments.get(Number(assignments[1])) ?? []
  }
  if (url.pathname === '/api/v1/announcements') {
    return announcementsFor(account, url)
  }
  return canvasResponse(HTTP_NOT_FOUND, { errors: [{ message: 'not found' }] })
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// 실제 fetch처럼 redirect 옵션이 없으면(기본 'follow') Location을 따라간다. 가장 나쁜 경우를 흉내 내 헤더(Authorization)도 그대로 넘긴다.
// 'manual'이면 3xx 응답을 그대로 돌려주고, 'error'면 fetch처럼 TypeError로 거부한다.
async function followRedirects(state, url, init, response) {
  if (!REDIRECT_STATUSES.has(response.status) || init.redirect === 'manual') {
    return response
  }
  if (init.redirect === 'error') {
    throw new TypeError('fetch failed: redirect mode is set to error')
  }
  return handleRequest(state, new URL(response.headers.get('location'), url), init)
}

async function handleRequest(state, input, init = {}) {
  const url = new URL(String(input))
  if (url.origin !== CANVAS_BASE_URL) {
    state.foreignRequests.push({ url, headers: new Headers(init.headers) })
    return canvasResponse(HTTP_OK, [])
  }
  const req = { url, path: url.pathname, page: Number(url.searchParams.get('page') ?? '1'), token: bearerToken(init.headers), init }
  state.requests.push(req)
  for (const interceptor of state.interceptors) {
    if (interceptor.remaining > 0 && interceptor.match(req)) {
      interceptor.remaining -= 1
      const response = await interceptor.respond(req)
      if (response) {
        return followRedirects(state, url, init, response)
      }
    }
  }
  const owner = state.accounts.get(req.token)
  if (!owner) {
    return canvasFailures.unauthorized()
  }
  const result = route(owner, url)
  return result instanceof Response ? result : paginate(url, result, state.pageSize)
}

export function createFakeCanvas({ pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const state = { pageSize, accounts: new Map(), requests: [], foreignRequests: [], interceptors: [] }

  function account(token) {
    const found = state.accounts.get(token)
    if (!found) {
      throw new Error('fake canvas: 등록하지 않은 토큰')
    }
    return found
  }

  return {
    fetch: (input, init) => handleRequest(state, input, init),
    requests: state.requests,
    foreignRequests: state.foreignRequests,
    addAccount(token, { id, name = '학생' }) {
      state.accounts.set(token, { self: { id, name }, courses: [], assignments: new Map(), announcements: new Map() })
    },
    setCourses: (token, courses) => {
      account(token).courses = courses
    },
    setAssignments: (token, courseId, list) => account(token).assignments.set(courseId, list),
    setAnnouncements: (token, courseId, list) => account(token).announcements.set(courseId, list),
    // match(req)가 참인 요청에 respond(req)의 응답을 돌려준다. respond가 아무것도 안 돌려주면 원래 처리로 넘어간다(중간에 끼어들기용).
    intercept(match, respond, { times = Infinity } = {}) {
      state.interceptors.push({ match, respond, remaining: times })
    },
    clearIntercepts() {
      state.interceptors.length = 0
    },
    requestsWithToken: (token) => state.requests.filter((r) => r.token === token),
  }
}
