// 실제 iCloud 공개 캘린더 대신 쓰는 fetch (ADR 0010). 직접 확인한 동작을 흉내 낸다:
// 등록된 링크는 200 text/calendar, 없는 published 토큰은 400(본문 없음). 리다이렉트는 fetch 기본 동작(따라감)을 흉내 내
// redirect 옵션이 'manual'이 아니면 헤더째 따라간다("가장 나쁜 fetch"). iCloud가 아닌 호스트로 간 요청은 따로 모은다.
export const ICLOUD_HOST = 'p52-caldav.icloud.com'
// AbortSignal.timeout이 끝났을 때의 이유(reason)와 같은 에러
export const timeoutReason = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')
const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// 공개 링크 모양 (토큰은 불투명 문자열)
export function icloudUrl(token, { scheme = 'webcal', host = ICLOUD_HOST } = {}) {
  return `${scheme}://${host}/published/2/${token}`
}

export function icsResponse(body, { contentType = 'text/calendar; charset=UTF-8', status = HTTP_OK, headers = {} } = {}) {
  return new Response(body, { status, headers: { 'Content-Type': contentType, ...headers } })
}

export const icloudFailures = {
  badRequest: () => new Response(null, { status: HTTP_BAD_REQUEST }),
  notFound: () => new Response(null, { status: 404 }),
  serverError: () => new Response('error', { status: 500 }),
  rateLimited: () => new Response('slow down', { status: 429 }),
  html: () => icsResponse('<html>maintenance</html>', { contentType: 'text/html' }),
  networkError: () => Promise.reject(new TypeError('fetch failed')),
  // AbortSignal.timeout이 끝났을 때 fetch가 내는 것과 같은 에러로 바로 거부한다(실제 타이머를 기다리지 않음:
  // 그 타이머는 이벤트 루프를 붙잡지 않아 Node 22에서 테스트가 먼저 끝나 버린다)
  timeoutError: () => Promise.reject(timeoutReason()),
  redirect: (location, status = 301) => new Response(null, { status, headers: { Location: location } }),
}

// totalBytes만큼 조금씩 흘려보내는 본문. pulled()로 실제로 읽힌 양을 본다. stallAfter면 그만큼 보낸 뒤 멈추고,
// 멈춘 순간 onStall을 한 번 부른다(테스트가 그때 타임아웃 신호를 끊어 실제 타이머 없이 "본문이 멈춤"을 재현)
export function streamedBody(totalBytes, { chunkBytes = 64 * 1024, stallAfter = null, onStall = () => {} } = {}) {
  let stalled = false
  let sent = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (stallAfter !== null && sent >= stallAfter) {
        if (!stalled) {
          stalled = true
          onStall()
        }
        return new Promise(() => {})
      }
      if (sent >= totalBytes) {
        controller.close()
        return undefined
      }
      const size = Math.min(chunkBytes, totalBytes - sent)
      sent += size
      controller.enqueue(new Uint8Array(size).fill(0x41))
      return undefined
    },
  })
  return { stream, pulled: () => sent }
}

async function handle(state, input, init = {}) {
  const url = new URL(String(input))
  const req = { url, path: url.pathname, headers: new Headers(init.headers), init }
  if (url.hostname !== 'icloud.com' && !url.hostname.endsWith('.icloud.com')) {
    state.foreignRequests.push(req)
    return icsResponse('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
  }
  state.requests.push(req)
  for (const interceptor of state.interceptors) {
    if (interceptor.remaining > 0 && interceptor.match(req)) {
      interceptor.remaining -= 1
      const response = await interceptor.respond(req)
      if (response) {
        return follow(state, url, init, response)
      }
    }
  }
  const redirect = state.redirects.get(`${url.hostname}${url.pathname}`)
  if (redirect) {
    return follow(state, url, init, icloudFailures.redirect(redirect.location, redirect.status))
  }
  const calendar = state.calendars.get(`${url.hostname}${url.pathname}`)
  return calendar ? icsResponse(calendar.body, calendar.options) : icloudFailures.badRequest()
}

function follow(state, url, init, response) {
  if (!REDIRECT_STATUSES.has(response.status) || init.redirect === 'manual') {
    return response
  }
  if (init.redirect === 'error') {
    throw new TypeError('fetch failed: redirect mode is set to error')
  }
  return handle(state, new URL(response.headers.get('location'), url), init)
}

export function createFakeIcloud() {
  const state = { calendars: new Map(), redirects: new Map(), interceptors: [], requests: [], foreignRequests: [] }
  const keyOf = (token, host) => `${host}/published/2/${token}`
  return {
    fetch: (input, init) => handle(state, input, init),
    requests: state.requests,
    foreignRequests: state.foreignRequests,
    // 공개 링크 하나의 ICS 본문을 정한다(바꿀 때도 같은 함수)
    setCalendar(token, body, { host = ICLOUD_HOST, ...options } = {}) {
      state.calendars.set(keyOf(token, host), { body, options })
    },
    removeCalendar(token, { host = ICLOUD_HOST } = {}) {
      state.calendars.delete(keyOf(token, host))
    },
    setRedirect(token, location, { host = ICLOUD_HOST, status = 301 } = {}) {
      state.redirects.set(keyOf(token, host), { location, status })
    },
    // match(req)가 참인 요청에 respond(req)의 응답. respond가 아무것도 안 돌려주면 원래 처리로
    intercept(match, respond, { times = Infinity } = {}) {
      state.interceptors.push({ match, respond, remaining: times })
    },
    clearIntercepts() {
      state.interceptors.length = 0
    },
    requestsFor: (token) => state.requests.filter((r) => r.path.endsWith(`/${token}`)),
  }
}
