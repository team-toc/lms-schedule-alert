import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasFailures } from './helpers/fake-canvas.js'
import {
  buildLmsApp,
  signedInUser,
  registerToken,
  connectUser,
  userLinks,
  holdRequests,
  STATUS_PATH,
  SYNC_PATH,
  MINUTE_MS,
  TOKEN_A,
  TOKEN_B,
} from './helpers/lms-context.js'

const STATUS_KEYS = ['connectedAt', 'lastErrorCode', 'lastSyncedAt', 'status']

describe('GET /api/lms/status · POST /api/lms/sync', () => {
  let ctx
  let canvas
  let built

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    canvas = createFakeCanvas()
    built = buildLmsApp(ctx, { canvas })
    for (const [token, id] of [
      [TOKEN_A, 9001],
      [TOKEN_B, 9002],
    ]) {
      canvas.addAccount(token, { id })
      canvas.setCourses(token, [canvasCourse(101)])
      canvas.setAssignments(token, 101, [canvasAssignment(101, 501)])
    }
  })
  after(async () => {
    await ctx.close()
  })

  it('연결 전: status not_connected (200)', async () => {
    const { agent } = await signedInUser(built.app)

    const res = await agent.get(STATUS_PATH).expect(200)

    assert.deepEqual(res.body, { status: 'not_connected' })
  })

  it('첫 동기화가 끝나기 전에는 syncing, 끝나면 ok · 시각(UTC ISO) · 오류 없음, 토큰은 응답에 없다', async () => {
    const { agent } = await signedInUser(built.app)
    const hold = holdRequests(canvas, (r) => r.path === '/api/v1/courses')
    await registerToken(agent, TOKEN_A).expect(202)
    await hold.reached

    const during = await agent.get(STATUS_PATH).expect(200)
    hold.release()
    await built.lms.syncRunner.whenIdle()
    const done = await agent.get(STATUS_PATH).expect(200)

    assert.equal(during.body.status, 'syncing')
    assert.equal(during.body.lastSyncedAt, null)
    assert.deepEqual(Object.keys(done.body).sort(), STATUS_KEYS)
    assert.equal(done.body.status, 'ok')
    assert.equal(done.body.lastSyncedAt, built.clock.now().toISOString())
    assert.match(done.body.connectedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.equal(done.body.lastErrorCode, null)
    assert.ok(!JSON.stringify(done.body).includes(TOKEN_A) && !JSON.stringify(done.body).includes('v1:'))
  })

  it('동기화가 실패하면 failing + lastErrorCode, 401이면 needs_reauth', async () => {
    const { agent, userId } = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })

    canvas.intercept((r) => r.path === '/api/v1/courses', canvasFailures.rateLimited429, { times: 1 })
    await built.lms.lmsSync.syncUser(userId)
    assert.deepEqual(
      (({ status, lastErrorCode }) => ({ status, lastErrorCode }))((await agent.get(STATUS_PATH).expect(200)).body),
      { status: 'failing', lastErrorCode: 'canvas_rate_limited' },
    )

    canvas.intercept((r) => r.path === '/api/v1/courses', canvasFailures.unauthorized, { times: 1 })
    await built.lms.lmsSync.syncUser(userId)
    assert.equal((await agent.get(STATUS_PATH).expect(200)).body.status, 'needs_reauth')
  })

  it('POST /sync: 연결 전이면 404 lms_not_connected (Canvas 호출 없음)', async () => {
    const { agent } = await signedInUser(built.app)

    const res = await agent.post(SYNC_PATH).expect(404)

    assert.equal(res.body.error, 'lms_not_connected')
    assert.equal(canvas.requests.length, 0)
  })

  it('POST /sync: 202 { status }, 백그라운드로 동기화해 Canvas 변경을 반영한다', async () => {
    const { agent, userId } = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    canvas.setAssignments(TOKEN_A, 101, [])

    const res = await agent.post(SYNC_PATH).expect(202)
    await built.lms.syncRunner.whenIdle()

    assert.deepEqual(res.body, { status: 'ok' })
    assert.deepEqual((await userLinks(ctx.pool, userId)).assignments, [])
  })

  it('POST /sync: 5분 안에 다시 부르면 429 sync_too_frequent + Retry-After(남은 초), 5분 뒤에는 다시 된다 (사용자별)', async () => {
    const a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    const b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
    await a.agent.post(SYNC_PATH).expect(202)
    await built.lms.syncRunner.whenIdle()
    const requestsBefore = canvas.requests.length
    built.clock.advance(2 * MINUTE_MS)

    const limited = await a.agent.post(SYNC_PATH).expect(429)

    assert.equal(limited.body.error, 'sync_too_frequent')
    assert.equal(limited.headers['retry-after'], String(3 * 60))
    assert.equal(canvas.requests.length, requestsBefore, '제한된 요청은 Canvas를 부르지 않는다')
    await b.agent.post(SYNC_PATH).expect(202)

    built.clock.advance(3 * MINUTE_MS)
    await a.agent.post(SYNC_PATH).expect(202)
    await built.lms.syncRunner.whenIdle()
  })

  it('POST /sync: needs_reauth면 409 lms_needs_reauth (토큰을 다시 등록해야 함), Canvas 호출 없음', async () => {
    const { agent, userId } = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    canvas.intercept((r) => r.path === '/api/v1/courses', canvasFailures.unauthorized, { times: 1 })
    await built.lms.lmsSync.syncUser(userId)
    const requestsBefore = canvas.requests.length

    const res = await agent.post(SYNC_PATH).expect(409)

    assert.equal(res.body.error, 'lms_needs_reauth')
    assert.equal(canvas.requests.length, requestsBefore)
  })
})
