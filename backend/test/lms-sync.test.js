import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasAnnouncement, canvasFailures } from './helpers/fake-canvas.js'
import { networkError } from './helpers/fake-google.js'
import { buildLmsApp, signedInUser, registerToken, connectUser, tokenRow, userLinks, snapshotLmsTables, MINUTE_MS, DAY_MS, TOKEN_A } from './helpers/lms-context.js'

const COURSE_IDS = [101, 102, 103, 104, 105]
const due = (day) => `2026-11-${String(day).padStart(2, '0')}T14:59:00Z`

// 과목 5개(3페이지), 101에 과제 5개(3페이지), 103에 과제 3개(2페이지), 101에 공지 3개(2페이지)
function seedCanvas(canvas, clock) {
  canvas.addAccount(TOKEN_A, { id: 9001 })
  canvas.setCourses(TOKEN_A, COURSE_IDS.map((id) => canvasCourse(id)))
  canvas.setAssignments(TOKEN_A, 101, [1, 2, 3, 4, 5].map((n) => canvasAssignment(101, 500 + n, { dueAt: due(n + 14) })))
  canvas.setAssignments(TOKEN_A, 103, [1, 2, 3].map((n) => canvasAssignment(103, 600 + n, { dueAt: due(n + 20) })))
  const posted = (daysAgo) => new Date(clock.now().getTime() - daysAgo * DAY_MS).toISOString()
  canvas.setAnnouncements(TOKEN_A, 101, [1, 2, 3].map((n) => canvasAnnouncement(101, 700 + n, { postedAt: posted(n) })))
}

// "동기화가 아무것도 바꾸지 않았다": lms_tokens(상태 칼럼)를 뺀 6개 테이블이 그대로
function withoutTokens(snapshot) {
  const { lms_tokens: _ignored, ...rest } = snapshot
  return rest
}

describe('동기화: 여러 페이지 · 부분 실패 · 반복 실행', () => {
  let ctx
  let canvas
  let built
  let user

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    canvas = createFakeCanvas({ pageSize: 2 })
    built = buildLmsApp(ctx, { canvas })
    seedCanvas(canvas, built.clock)
  })
  after(async () => {
    await ctx.close()
  })

  it('3. 여러 페이지에 걸친 과목 · 과제 · 공지를 끝까지 모두 저장한다', async () => {
    user = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })

    const links = await userLinks(ctx.pool, user.userId)
    assert.deepEqual(links.courses, COURSE_IDS)
    assert.deepEqual(links.assignments.map((a) => a.id), [501, 502, 503, 504, 505, 601, 602, 603])
    assert.deepEqual(links.announcements, [701, 702, 703])
    assert.equal(canvas.requests.filter((r) => r.path === '/api/v1/courses').length, 3)
    assert.equal(canvas.requests.filter((r) => r.path === '/api/v1/courses/101/assignments').length, 3)
    assert.equal(await ctx.countRows('courses'), 5)
  })

  it('첫 동기화가 중간에 실패하면 아무것도 저장하지 않고 failing', async () => {
    const { agent, userId } = await signedInUser(built.app, 'a@example.com')
    canvas.intercept((r) => r.path === '/api/v1/courses/103/assignments' && r.page === 2, canvasFailures.serverError)

    await registerToken(agent, TOKEN_A).expect(202)
    await built.lms.syncRunner.whenIdle()

    for (const table of ['courses', 'enrollments', 'assignments', 'user_assignments', 'announcements', 'user_announcements']) {
      assert.equal(await ctx.countRows(table), 0, table)
    }
    const row = await tokenRow(ctx.pool, userId)
    assert.equal(row.status, 'failing')
    assert.equal(row.last_error_code, 'canvas_unavailable')
    assert.equal(row.last_synced_at, null)
  })

  const failurePoints = [
    ['과목 목록 2페이지 500', (r) => r.path === '/api/v1/courses' && r.page === 2, canvasFailures.serverError, 'canvas_unavailable'],
    ['과제 목록 2페이지 500', (r) => r.path === '/api/v1/courses/103/assignments' && r.page === 2, canvasFailures.serverError, 'canvas_unavailable'],
    ['공지 목록 1페이지 네트워크 오류', (r) => r.path === '/api/v1/announcements', networkError, 'canvas_unavailable'],
    ['마지막 과목의 과제 목록 응답이 JSON 아님', (r) => r.path === '/api/v1/courses/105/assignments', canvasFailures.notJson, 'canvas_unavailable'],
  ]
  for (const [label, match, respond, errorCode] of failurePoints) {
    it(`4. 다시 동기화하다 ${label} → 이전 상태 그대로(삭제 · 변경 판단 안 함), failing · ${errorCode}`, async () => {
      user = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
      const before = await snapshotLmsTables(ctx.pool)
      const syncedAt = (await tokenRow(ctx.pool, user.userId)).last_synced_at
      // Canvas 쪽이 바뀐다: 과목 104 빠짐, 101 이름 변경, 과제 501 빠짐 · 506 추가
      canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '바뀐 이름' }), canvasCourse(102), canvasCourse(103), canvasCourse(105)])
      canvas.setAssignments(TOKEN_A, 101, [2, 3, 4, 5, 6].map((n) => canvasAssignment(101, 500 + n, { dueAt: due(n + 14) })))
      canvas.intercept(match, respond)
      built.clock.advance(MINUTE_MS)

      const result = await built.lms.lmsSync.syncUser(user.userId)

      assert.deepEqual(result, { outcome: 'failed', errorCode })
      assert.deepEqual(withoutTokens(await snapshotLmsTables(ctx.pool)), withoutTokens(before))
      const row = await tokenRow(ctx.pool, user.userId)
      assert.equal(row.status, 'failing')
      assert.equal(row.last_error_code, errorCode)
      assert.deepEqual(row.last_synced_at, syncedAt, '반영하지 않았으니 마지막 동기화 시각도 그대로')
    })
  }

  it('8. 바뀐 것이 없으면 다시 동기화해도 행 · 시각(updated_at 포함)이 그대로 (멱등), last_synced_at만 앞으로', async () => {
    user = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    const before = await snapshotLmsTables(ctx.pool)
    built.clock.advance(MINUTE_MS)

    const result = await built.lms.lmsSync.syncUser(user.userId)
    const again = await built.lms.lmsSync.syncUser(user.userId)

    assert.deepEqual(result, { outcome: 'applied' })
    assert.deepEqual(again, { outcome: 'applied' })
    assert.deepEqual(withoutTokens(await snapshotLmsTables(ctx.pool)), withoutTokens(before))
    assert.deepEqual((await tokenRow(ctx.pool, user.userId)).last_synced_at, built.clock.now())
  })

  it('실패 뒤 다음 동기화가 성공하면 ok로 돌아오고 오류 코드를 지운다', async () => {
    user = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    canvas.intercept((r) => r.path === '/api/v1/courses', canvasFailures.serverError, { times: 1 })
    await built.lms.lmsSync.syncUser(user.userId)

    assert.deepEqual(await built.lms.lmsSync.syncUser(user.userId), { outcome: 'applied' })

    const row = await tokenRow(ctx.pool, user.userId)
    assert.equal(row.status, 'ok')
    assert.equal(row.last_error_code, null)
  })

  it('바뀐 과제 제목은 공유 행에서 고쳐지고 해시가 바뀐다 (그 행만)', async () => {
    user = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    const [before] = await ctx.pool.query('SELECT canvas_id, title, content_hash FROM assignments ORDER BY canvas_id')
    canvas.setAssignments(TOKEN_A, 101, [1, 2, 3, 4, 5].map((n) => canvasAssignment(101, 500 + n, { dueAt: due(n + 14), name: n === 1 ? '바뀐 제목' : undefined })))

    await built.lms.lmsSync.syncUser(user.userId)

    const [after] = await ctx.pool.query('SELECT canvas_id, title, content_hash FROM assignments ORDER BY canvas_id')
    assert.equal(after[0].title, '바뀐 제목')
    assert.notEqual(after[0].content_hash, before[0].content_hash)
    assert.deepEqual(after.slice(1).map((r) => ({ ...r })), before.slice(1).map((r) => ({ ...r })))
  })
})
