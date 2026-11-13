import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createCanvasClient, CanvasApiError } from '../src/canvas/canvas-client.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasAnnouncement, canvasFailures, canvasResponse, CANVAS_BASE_URL } from './helpers/fake-canvas.js'
import { networkError, timesOut } from './helpers/fake-google.js'

const TOKEN = '7~ClientTest0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRST'
const COURSES = [101, 102, 103, 104, 105].map((id) => canvasCourse(id))

function assertCanvasError(err, { code, status = undefined, path = undefined }) {
  assert.ok(err instanceof CanvasApiError, `CanvasApiError여야 함: ${err?.name} ${err?.message}`)
  assert.equal(err.code, code)
  if (status !== undefined) {
    assert.equal(err.status, status)
  }
  if (path !== undefined) {
    assert.equal(err.path, path, '경로만 (쿼리 없음)')
  }
  const visible = `${err.message} ${JSON.stringify(err)} ${err.stack}`
  assert.ok(!visible.includes(TOKEN), '에러에 토큰 금지')
  assert.ok(!visible.includes(TOKEN.slice(0, 10)) && !visible.includes(TOKEN.slice(-10)), '에러에 토큰 일부 금지')
  return true
}

describe('Canvas 클라이언트 (경계 레이어)', () => {
  let canvas
  let client

  beforeEach(() => {
    canvas = createFakeCanvas({ pageSize: 2 })
    canvas.addAccount(TOKEN, { id: 9001, name: '학생' })
    canvas.setCourses(TOKEN, COURSES)
    client = createCanvasClient({ baseUrl: CANVAS_BASE_URL, fetchFn: canvas.fetch })
  })

  it('getSelf: /api/v1/users/self, 토큰은 Authorization: Bearer 헤더로만 (URL에 없음), 타임아웃 신호를 붙인다', async () => {
    const self = await client.getSelf(TOKEN)

    // id는 문자열로 받는다 (Accept: application/json+canvas-string-ids, ADR 0009)
    assert.equal(self.id, '9001')
    const [req] = canvas.requests
    assert.equal(req.path, '/api/v1/users/self')
    assert.equal(req.token, TOKEN)
    assert.ok(!req.url.toString().includes(TOKEN) && !req.url.searchParams.has('access_token'))
    assert.ok(req.init.signal instanceof AbortSignal, '요청마다 타임아웃 신호')
    assert.match(new Headers(req.init.headers).get('accept'), /application\/json\+canvas-string-ids/)
  })

  it('getSelf: 2^53을 넘는 Canvas id도 정밀도 손실 없이 문자열 그대로', async () => {
    canvas.addAccount('8~big', { id: '9007199254740993' })

    assert.equal((await client.getSelf('8~big')).id, '9007199254740993')
  })

  it('3. listActiveCourses: enrollment_state=active · per_page=100, Link rel="next"를 끝까지 따라가 순서대로 모두 돌려준다', async () => {
    const courses = await client.listActiveCourses(TOKEN)

    assert.deepEqual(courses.map((c) => c.id), [101, 102, 103, 104, 105])
    assert.equal(canvas.requests.length, 3)
    const first = canvas.requests[0].url.searchParams
    assert.equal(first.get('enrollment_state'), 'active')
    assert.equal(first.get('per_page'), '100')
    assert.equal(canvas.requests[1].url.searchParams.get('opaque'), 'cursor2', '다음 페이지는 Link의 URL을 그대로 쓴다')
  })

  it('listAssignments: 과목별 경로, 여러 페이지를 모두', async () => {
    const list = [1, 2, 3].map((id) => canvasAssignment(101, id))
    canvas.setAssignments(TOKEN, 101, list)

    assert.deepEqual(await client.listAssignments(TOKEN, 101), list)
    assert.ok(canvas.requests.every((r) => r.path === '/api/v1/courses/101/assignments'))
  })

  it('listAnnouncements: context_codes[]는 과목 하나, start_date · end_date는 ISO 8601', async () => {
    canvas.setAnnouncements(TOKEN, 101, [canvasAnnouncement(101, 7, { postedAt: '2026-11-10T00:00:00Z' })])
    const startDate = new Date('2026-10-14T00:00:00Z')
    const endDate = new Date('2026-11-13T00:00:00Z')

    const list = await client.listAnnouncements(TOKEN, 101, { startDate, endDate })

    assert.deepEqual(list.map((a) => a.id), [7])
    const params = canvas.requests[0].url.searchParams
    assert.deepEqual(params.getAll('context_codes[]'), ['course_101'])
    assert.equal(params.get('start_date'), '2026-10-14T00:00:00.000Z')
    assert.equal(params.get('end_date'), '2026-11-13T00:00:00.000Z')
  })

  it('페이지가 상한(maxPages)을 넘으면 canvas_too_many_pages (일부만 돌려주지 않음)', async () => {
    const limited = createCanvasClient({ baseUrl: CANVAS_BASE_URL, fetchFn: canvas.fetch, maxPages: 2 })

    await assert.rejects(limited.listActiveCourses(TOKEN), (err) => assertCanvasError(err, { code: 'canvas_too_many_pages' }))
  })

  it('next 링크가 다른 출처면 따라가지 않고 canvas_bad_link (토큰이 다른 호스트로 가지 않음)', async () => {
    canvas.intercept(
      (r) => r.path === '/api/v1/courses',
      () => canvasResponse(200, [COURSES[0]], { Link: '<https://evil.test/api/v1/courses?page=2>; rel="next"' }),
    )

    await assert.rejects(client.listActiveCourses(TOKEN), (err) => assertCanvasError(err, { code: 'canvas_bad_link' }))
    assert.equal(canvas.foreignRequests.length, 0)
  })

  for (const status of [301, 302, 303, 307, 308]) {
    it(`HTTP ${status}로 다른 호스트를 가리켜도 따라가지 않는다 (그 호스트로 요청 0번, canvas_unexpected_redirect)`, async () => {
      canvas.intercept((r) => r.path === '/api/v1/courses', () => canvasResponse(status, '', { Location: 'https://evil.test/collect' }))

      await assert.rejects(client.listActiveCourses(TOKEN), (err) => assertCanvasError(err, { code: 'canvas_unexpected_redirect', status, path: '/api/v1/courses' }))
      assert.equal(canvas.foreignRequests.length, 0)
    })
  }

  it('같은 출처로의 302도 따라가지 않는다 (요청은 처음 하나뿐)', async () => {
    canvas.intercept((r) => r.path === '/api/v1/users/self', () => canvasResponse(302, '', { Location: `${CANVAS_BASE_URL}/api/v1/users/self?moved=1` }), { times: 1 })

    await assert.rejects(client.getSelf(TOKEN), (err) => assertCanvasError(err, { code: 'canvas_unexpected_redirect', status: 302 }))
    assert.equal(canvas.requests.length, 1)
  })

  it('2페이지에서 실패하면 1페이지 결과도 돌려주지 않고 에러', async () => {
    canvas.intercept((r) => r.page === 2, canvasFailures.serverError)

    await assert.rejects(client.listActiveCourses(TOKEN), (err) => assertCanvasError(err, { code: 'canvas_unavailable', status: 500 }))
  })

  const failures = [
    ['401 + WWW-Authenticate (만료 · 취소된 토큰)', canvasFailures.unauthorized, 'canvas_unauthorized', 401],
    ['WWW-Authenticate 없는 401 (권한 없음)', canvasFailures.unauthorizedWithoutChallenge, 'canvas_forbidden', 401],
    ['403 (권한 없음)', canvasFailures.forbidden, 'canvas_forbidden', 403],
    ['429 (요청 제한)', canvasFailures.rateLimited429, 'canvas_rate_limited', 429],
    ['403 + "Rate Limit Exceeded" (요청 제한)', canvasFailures.rateLimited403, 'canvas_rate_limited', 403],
    ['500', canvasFailures.serverError, 'canvas_unavailable', 500],
    ['200인데 JSON이 아님', canvasFailures.notJson, 'canvas_unavailable', 200],
    ['200인데 목록이 아님', () => canvasResponse(200, { not: 'a list' }), 'canvas_unavailable', 200],
    ['네트워크 오류', networkError, 'canvas_unavailable', null],
    ['타임아웃', timesOut, 'canvas_timeout', null],
  ]
  for (const [label, respond, code, status] of failures) {
    it(`실패 응답: ${label} → ${code}, 에러에 토큰 · 토큰 일부가 없다`, async () => {
      canvas.intercept((r) => r.path === '/api/v1/courses', respond)

      await assert.rejects(client.listActiveCourses(TOKEN), (err) => assertCanvasError(err, { code, status, path: '/api/v1/courses' }))
    })
  }

  it('Canvas 응답 본문에 토큰이 들어 있어도 에러 메시지로 옮기지 않는다', async () => {
    canvas.intercept((r) => r.path === '/api/v1/users/self', () => canvasResponse(500, { errors: [{ message: `bad token ${TOKEN}` }] }))

    await assert.rejects(client.getSelf(TOKEN), (err) => assertCanvasError(err, { code: 'canvas_unavailable' }))
  })
})
