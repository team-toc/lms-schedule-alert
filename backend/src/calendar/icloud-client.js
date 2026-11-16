// iCloud 공개 캘린더 가져오기 (경계 레이어, ADR 0010). ICS 본문 문자열만 돌려준다(파싱은 ics-events.js).
// - 처음 주소와 리다이렉트 대상을 매번 같은 규칙으로 검사(https · 443 · iCloud 호스트 · 계정 정보 없음). 자동 리다이렉트는 끈다
// - 리다이렉트는 최대 maxRedirects번, 전체(모든 요청 + 본문 읽기)에 타임아웃 하나, 본문은 maxBytes를 넘는 순간 끊는다
// - Content-Type은 text/calendar만
// - 링크 원문 · 토큰 · 응답 본문은 에러에 넣지 않는다(코드 · 상태만). 원래 에러(cause)도 붙이지 않는다(주소가 들어 있을 수 있음)
import { isAllowedIcloudUrl } from './icloud-url.js'

const REQUEST_TIMEOUT_MS = 10000
const MAX_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const LINK_INVALID_STATUSES = new Set([400, 404, 410])
const HTTP_TOO_MANY_REQUESTS = 429

export const ICLOUD_ERRORS = {
  linkInvalid: 'icloud_link_invalid',
  rateLimited: 'icloud_rate_limited',
  unavailable: 'icloud_unavailable',
  timeout: 'icloud_timeout',
  tooLarge: 'icloud_too_large',
  notCalendar: 'icloud_not_calendar',
  redirectRejected: 'icloud_redirect_rejected',
  tooManyRedirects: 'icloud_too_many_redirects',
  urlNotAllowed: 'icloud_url_not_allowed',
}

export class IcloudFetchError extends Error {
  constructor(code, { status = null } = {}) {
    super(`iCloud 캘린더 요청 실패: ${code}${status ? ` (HTTP ${status})` : ''}`)
    this.name = 'IcloudFetchError'
    this.code = code
    this.status = status
  }
}

const isTimeout = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError'

function allowedUrl(value, base) {
  try {
    const url = base ? new URL(value, base) : new URL(value)
    return isAllowedIcloudUrl(url) ? url : null
  } catch {
    return null
  }
}

function failureFor(res) {
  if (LINK_INVALID_STATUSES.has(res.status)) return ICLOUD_ERRORS.linkInvalid
  if (res.status === HTTP_TOO_MANY_REQUESTS) return ICLOUD_ERRORS.rateLimited
  return ICLOUD_ERRORS.unavailable
}

const isCalendar = (contentType) => (contentType ?? '').split(';')[0].trim().toLowerCase() === 'text/calendar'

async function request({ fetchFn, signal }, url) {
  try {
    return await fetchFn(url.toString(), { headers: { Accept: 'text/calendar' }, redirect: 'manual', signal })
  } catch (err) {
    throw new IcloudFetchError(isTimeout(err) || signal.aborted ? ICLOUD_ERRORS.timeout : ICLOUD_ERRORS.unavailable)
  }
}

// 본문이 오다가 멈춰도 타임아웃이 걸리게, 읽기마다 중단 신호와 경주시킨다
function abortedPromise(signal) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new IcloudFetchError(ICLOUD_ERRORS.timeout))
    if (signal.aborted) fail()
    signal.addEventListener('abort', fail, { once: true })
  })
}

async function readLimited(res, { signal, maxBytes }) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new IcloudFetchError(ICLOUD_ERRORS.tooLarge, { status: res.status })
  }
  if (!res.body) {
    return ''
  }
  const reader = res.body.getReader()
  const aborted = abortedPromise(signal)
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new IcloudFetchError(ICLOUD_ERRORS.tooLarge, { status: res.status })
      chunks.push(value)
    }
  } finally {
    aborted.catch(() => {})
    reader.cancel().catch(() => {})
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

// 리다이렉트를 직접 따라가 최종 200 응답을 얻는다
async function followRedirects(deps, start) {
  let url = start
  for (let hop = 0; ; hop += 1) {
    const res = await request(deps, url)
    if (!REDIRECT_STATUSES.has(res.status)) {
      return res
    }
    await res.body?.cancel().catch(() => {})
    if (hop >= deps.maxRedirects) {
      throw new IcloudFetchError(ICLOUD_ERRORS.tooManyRedirects, { status: res.status })
    }
    const location = res.headers.get('location')
    url = location ? allowedUrl(location, url) : null
    if (!url) {
      throw new IcloudFetchError(ICLOUD_ERRORS.redirectRejected, { status: res.status })
    }
  }
}

export function createIcloudClient({ fetchFn = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_BYTES, maxRedirects = MAX_REDIRECTS } = {}) {
  // url: 정규화한 https 주소(icloud-url.js). 결과: ICS 본문 문자열
  async function fetchCalendar(url) {
    const start = typeof url === 'string' ? allowedUrl(url) : null
    if (!start) {
      throw new IcloudFetchError(ICLOUD_ERRORS.urlNotAllowed)
    }
    const signal = AbortSignal.timeout(timeoutMs)
    const deps = { fetchFn, signal, maxRedirects }
    const res = await followRedirects(deps, start)
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new IcloudFetchError(failureFor(res), { status: res.status })
    }
    if (!isCalendar(res.headers.get('content-type'))) {
      await res.body?.cancel().catch(() => {})
      throw new IcloudFetchError(ICLOUD_ERRORS.notCalendar, { status: res.status })
    }
    return readLimited(res, { signal, maxBytes })
  }

  return { fetchCalendar }
}
