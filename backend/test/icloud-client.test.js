import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createIcloudClient, IcloudFetchError, ICLOUD_ERRORS } from '../src/calendar/icloud-client.js'
import { createFakeIcloud, icloudUrl, icsResponse, icloudFailures, streamedBody, timeoutReason, ICLOUD_HOST } from './helpers/fake-icloud.js'
import { ics, vevent } from './helpers/ics-builder.js'

const TOKEN = 'CLIENTtestTOKENsecret0000111122223333'
const URL_A = icloudUrl(TOKEN, { scheme: 'https' })
const BODY = ics(vevent({ uid: 'u1', summary: '수업', start: '2026-11-20T01:00:00Z', end: '2026-11-20T02:00:00Z' }))
const MAX_BYTES = 1024 * 1024

// 에러에 링크 원문 · 토큰 · 토큰 일부가 없어야 한다
function assertIcloudError(err, code) {
  assert.ok(err instanceof IcloudFetchError, `IcloudFetchError가 아님: ${err?.name}`)
  assert.equal(err.code, code)
  const text = `${err.message} ${err.stack} ${JSON.stringify(err)} ${String(err.cause?.message ?? '')}`
  for (const secret of [TOKEN, TOKEN.slice(0, 12), TOKEN.slice(-12), URL_A]) {
    assert.ok(!text.includes(secret), '에러에 링크 · 토큰이 있으면 안 됨')
  }
  return true
}

// iCloud 공개 캘린더 가져오기 (경계 레이어, ADR 0010): 리다이렉트는 직접 · iCloud 호스트만 · 3번까지, 크기 · 시간 · 형식 검사
describe('iCloud 클라이언트', () => {
  let icloud
  let client

  beforeEach(() => {
    icloud = createFakeIcloud()
    icloud.setCalendar(TOKEN, BODY)
    client = createIcloudClient({ fetchFn: icloud.fetch, timeoutMs: 200, maxBytes: MAX_BYTES })
  })

  it('200 text/calendar → 본문 문자열. 리다이렉트는 manual, 타임아웃 신호, 쿠키 · 인증 헤더 없음', async () => {
    assert.equal(await client.fetchCalendar(URL_A), BODY)

    const [req] = icloud.requests
    assert.equal(req.init.redirect, 'manual')
    assert.ok(req.init.signal instanceof AbortSignal)
    assert.ok(!req.headers.has('authorization') && !req.headers.has('cookie'))
    assert.match(req.headers.get('accept') ?? '', /text\/calendar/)
  })

  it('타임아웃 신호: 기본은 AbortSignal.timeout(timeoutMs) 하나를 모든 요청에, 바꿔 끼운 함수는 timeoutMs로 한 번 불린다', async () => {
    const realTimeout = AbortSignal.timeout
    const made = []
    AbortSignal.timeout = (ms) => {
      const signal = realTimeout.call(AbortSignal, ms)
      made.push({ ms, signal })
      return signal
    }
    try {
      icloud.setRedirect(TOKEN, `/published/2/${TOKEN}next`)
      icloud.setCalendar(`${TOKEN}next`, BODY)
      assert.equal(await client.fetchCalendar(URL_A), BODY)
    } finally {
      AbortSignal.timeout = realTimeout
    }
    assert.deepEqual(made.map((m) => m.ms), [200], '기본값: AbortSignal.timeout(timeoutMs) 한 번')
    assert.deepEqual(icloud.requests.map((r) => r.init.signal === made[0].signal), [true, true], '리다이렉트한 요청까지 같은 신호')

    const controller = new AbortController()
    const calls = []
    const injected = createIcloudClient({ fetchFn: icloud.fetch, timeoutMs: 1234, createTimeoutSignal: (ms) => (calls.push(ms), controller.signal) })
    await injected.fetchCalendar(URL_A)
    assert.deepEqual(calls, [1234])
    assert.equal(icloud.requests.at(-1).init.signal, controller.signal)
  })

  it('Content-Type은 text/calendar만 (파라미터 · 대소문자 허용), 아니면 icloud_not_calendar', async () => {
    for (const contentType of ['text/calendar', 'TEXT/CALENDAR; charset=utf-8']) {
      icloud.intercept(() => true, () => icsResponse(BODY, { contentType }), { times: 1 })
      assert.equal(await client.fetchCalendar(URL_A), BODY, contentType)
    }
    for (const respond of [icloudFailures.html, () => icsResponse(BODY, { contentType: 'application/octet-stream' }), () => new Response(BODY, { status: 200 })]) {
      icloud.intercept(() => true, respond, { times: 1 })
      await assert.rejects(client.fetchCalendar(URL_A), (err) => assertIcloudError(err, ICLOUD_ERRORS.notCalendar))
    }
  })

  it('상태 코드: 400 · 404 · 410 → icloud_link_invalid, 429 → icloud_rate_limited, 5xx · 네트워크 오류 → icloud_unavailable', async () => {
    const cases = [
      [icloudFailures.badRequest, ICLOUD_ERRORS.linkInvalid],
      [icloudFailures.notFound, ICLOUD_ERRORS.linkInvalid],
      [() => new Response(null, { status: 410 }), ICLOUD_ERRORS.linkInvalid],
      [icloudFailures.rateLimited, ICLOUD_ERRORS.rateLimited],
      [icloudFailures.serverError, ICLOUD_ERRORS.unavailable],
      [icloudFailures.networkError, ICLOUD_ERRORS.unavailable],
    ]
    for (const [respond, code] of cases) {
      icloud.intercept(() => true, respond, { times: 1 })
      await assert.rejects(client.fetchCalendar(URL_A), (err) => assertIcloudError(err, code))
    }
  })

  // 실제 타이머를 기다리지 않는다: 응답 없음은 fetch가 TimeoutError로 거부하는 것으로, 본문 멈춤은 멈춘 순간 주입한 신호를 끊는 것으로
  it('타임아웃: 응답이 오지 않아 fetch가 TimeoutError로 끝나면 icloud_timeout, 본문이 중간에 멈춘 채 신호가 끊겨도 icloud_timeout', async () => {
    icloud.intercept(() => true, icloudFailures.timeoutError, { times: 1 })
    await assert.rejects(client.fetchCalendar(URL_A), (err) => assertIcloudError(err, ICLOUD_ERRORS.timeout))
    assert.ok(icloud.requests[0].init.signal instanceof AbortSignal, '요청에 타임아웃 신호가 붙어 있다')

    const controller = new AbortController()
    const stalling = createIcloudClient({ fetchFn: icloud.fetch, maxBytes: MAX_BYTES, createTimeoutSignal: () => controller.signal })
    const stalled = streamedBody(10_000, { chunkBytes: 1000, stallAfter: 3000, onStall: () => controller.abort(timeoutReason()) })
    icloud.intercept(() => true, () => icsResponse(stalled.stream), { times: 1 })
    await assert.rejects(stalling.fetchCalendar(URL_A), (err) => assertIcloudError(err, ICLOUD_ERRORS.timeout))
    assert.equal(stalled.pulled(), 3000, '멈출 때까지 읽다가 신호가 끊기면 그만둔다')
  })

  it('크기 상한: Content-Length가 넘으면 읽지 않고, 길이 없이 흘러와도 상한을 넘는 순간 끊고 icloud_too_large', async () => {
    icloud.intercept(() => true, () => icsResponse('x', { headers: { 'Content-Length': String(MAX_BYTES + 1) } }), { times: 1 })
    await assert.rejects(client.fetchCalendar(URL_A), (err) => assertIcloudError(err, ICLOUD_ERRORS.tooLarge))

    const big = streamedBody(MAX_BYTES * 4)
    icloud.intercept(() => true, () => icsResponse(big.stream), { times: 1 })
    await assert.rejects(client.fetchCalendar(URL_A), (err) => assertIcloudError(err, ICLOUD_ERRORS.tooLarge))
    assert.ok(big.pulled() <= MAX_BYTES * 2, `상한을 넘긴 뒤 계속 읽음: ${big.pulled()}`)
  })

  it('다른 iCloud 호스트로의 리다이렉트(301 · 302 · 307 · 308, 상대 경로 포함)는 직접 따라가 받는다', async () => {
    for (const status of [301, 302, 307, 308]) {
      const fresh = createFakeIcloud()
      const moved = `${TOKEN}moved${status}`
      fresh.setRedirect(TOKEN, `https://p150-caldav.icloud.com/published/2/${moved}`, { status })
      fresh.setCalendar(moved, BODY, { host: 'p150-caldav.icloud.com' })
      const c = createIcloudClient({ fetchFn: fresh.fetch, timeoutMs: 200, maxBytes: MAX_BYTES })

      assert.equal(await c.fetchCalendar(URL_A), BODY, String(status))
      assert.deepEqual(fresh.requests.map((r) => r.url.hostname), [ICLOUD_HOST, 'p150-caldav.icloud.com'])
    }
    icloud.setRedirect(TOKEN, `/published/2/${TOKEN}rel`)
    icloud.setCalendar(`${TOKEN}rel`, BODY)
    assert.equal(await client.fetchCalendar(URL_A), BODY, '상대 경로')
  })

  it('iCloud가 아닌 곳 · http · 다른 포트 · 계정 정보 · IP로의 리다이렉트는 따라가지 않고 icloud_redirect_rejected (그쪽으로 요청 0번)', async () => {
    for (const location of [
      'https://evil.example/steal',
      'https://icloud.com.evil.com/published/2/x',
      'https://evilicloud.com/published/2/x',
      'http://p150-caldav.icloud.com/published/2/x',
      'https://p150-caldav.icloud.com:8443/published/2/x',
      'https://user@p150-caldav.icloud.com/published/2/x',
      'https://127.0.0.1/published/2/x',
      'webcal://p150-caldav.icloud.com/published/2/x',
    ]) {
      icloud.intercept(() => true, () => icloudFailures.redirect(location), { times: 1 })
      await assert.rejects(client.fetchCalendar(URL_A), (err) => assertIcloudError(err, ICLOUD_ERRORS.redirectRejected))
    }
    icloud.intercept(() => true, () => new Response(null, { status: 302 }), { times: 1 })
    await assert.rejects(client.fetchCalendar(URL_A), (err) => assertIcloudError(err, ICLOUD_ERRORS.redirectRejected))
    assert.deepEqual(icloud.foreignRequests, [], 'iCloud 밖으로 나간 요청 없음')
  })

  it('리다이렉트는 최대 3번: 4번째는 따라가지 않고 icloud_too_many_redirects', async () => {
    const hops = ['h1', 'h2', 'h3', 'h4']
    icloud.setRedirect(TOKEN, `https://p1-caldav.icloud.com/published/2/${hops[0]}`)
    hops.forEach((hop, i) => icloud.setRedirect(hop, `https://p${i + 2}-caldav.icloud.com/published/2/${hops[i + 1] ?? 'end'}`, { host: `p${i + 1}-caldav.icloud.com` }))

    await assert.rejects(client.fetchCalendar(URL_A), (err) => assertIcloudError(err, ICLOUD_ERRORS.tooManyRedirects))
    assert.equal(icloud.requests.length, 4, '처음 + 3번 따라감')
  })

  it('처음 주소도 다시 검사: iCloud가 아닌 주소 · http를 직접 넘기면 요청하지 않고 icloud_url_not_allowed', async () => {
    for (const url of ['https://evil.example/x', 'http://p52-caldav.icloud.com/published/2/x', 'https://127.0.0.1/x']) {
      await assert.rejects(client.fetchCalendar(url), (err) => assertIcloudError(err, ICLOUD_ERRORS.urlNotAllowed))
    }
    assert.equal(icloud.requests.length + icloud.foreignRequests.length, 0)
  })
})
