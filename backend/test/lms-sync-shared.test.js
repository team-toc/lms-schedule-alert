import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasAnnouncement, CANVAS_BASE_URL } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, tokenRow, userLinks, MINUTE_MS, DAY_MS, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'

const DUE_A = '2026-11-20T14:59:00.000Z'
const DUE_B = '2026-11-27T14:59:00.000Z' // B는 개인 연장(override) → Canvas가 B에게는 다른 due_at을 준다

async function sharedRow(pool, table, canvasId) {
  const [rows] = await pool.query('SELECT * FROM ?? WHERE canvas_id = ?', [table, canvasId])
  return rows[0] ?? null
}

describe('동기화: 공유 행 · 사용자별 마감 · 사용자별 연결 해제', () => {
  let ctx
  let canvas
  let built
  let a
  let b

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    canvas = createFakeCanvas()
    built = buildLmsApp(ctx, { canvas })
    const posted = new Date(built.clock.now().getTime() - DAY_MS).toISOString()
    for (const [token, id, dueAt, extra] of [
      [TOKEN_A, 9001, DUE_A, []],
      [TOKEN_B, 9002, DUE_B, [canvasAssignment(101, 502, { dueAt: DUE_B })]], // 502는 B에게만 보이는 차등 과제
    ]) {
      canvas.addAccount(token, { id })
      canvas.setCourses(token, [canvasCourse(101, { name: '자료구조' })])
      canvas.setAssignments(token, 101, [canvasAssignment(101, 501, { dueAt }), ...extra])
      canvas.setAnnouncements(token, 101, [canvasAnnouncement(101, 701, { postedAt: posted })])
    }
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
  })
  after(async () => {
    await ctx.close()
  })

  it('5. 같은 과목의 두 사용자: 과목 · 과제 · 공지 행은 하나씩, 마감은 각자 자기 것, 차등 과제는 받은 사람에게만', async () => {
    assert.equal(await ctx.countRows('courses'), 1)
    assert.equal(await ctx.countRows('announcements'), 1)
    assert.equal(await ctx.countRows('assignments'), 2)
    assert.deepEqual((await userLinks(ctx.pool, a.userId)).assignments, [{ id: 501, dueAt: DUE_A }])
    assert.deepEqual((await userLinks(ctx.pool, b.userId)).assignments, [
      { id: 501, dueAt: DUE_B },
      { id: 502, dueAt: DUE_B },
    ])
  })

  it('A를 다시 동기화해도 B의 마감은 바뀌지 않는다 (공유 행에 마감을 두지 않음)', async () => {
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { dueAt: '2026-11-21T00:00:00Z' })])

    await built.lms.lmsSync.syncUser(a.userId)

    assert.deepEqual((await userLinks(ctx.pool, a.userId)).assignments, [{ id: 501, dueAt: '2026-11-21T00:00:00.000Z' }])
    assert.deepEqual((await userLinks(ctx.pool, b.userId)).assignments[0], { id: 501, dueAt: DUE_B })
  })

  it('6. A의 목록에서만 과제가 사라지면 A의 연결만 지우고, B의 연결 · 공유 행(deleted_at 없음)은 남는다', async () => {
    canvas.setAssignments(TOKEN_A, 101, [])

    await built.lms.lmsSync.syncUser(a.userId)

    assert.deepEqual((await userLinks(ctx.pool, a.userId)).assignments, [])
    assert.deepEqual((await userLinks(ctx.pool, b.userId)).assignments.map((x) => x.id), [501, 502])
    assert.equal((await sharedRow(ctx.pool, 'assignments', 501)).deleted_at, null)
  })

  it('6. 마지막 연결까지 사라지면 공유 행은 지우지 않고 deleted_at을 채운다, 다시 나타나면 deleted_at을 비우고 다시 잇는다', async () => {
    canvas.setAssignments(TOKEN_A, 101, [])
    canvas.setAssignments(TOKEN_B, 101, [canvasAssignment(101, 502, { dueAt: DUE_B })])
    await built.lms.lmsSync.syncUser(a.userId)
    built.clock.advance(MINUTE_MS)

    await built.lms.lmsSync.syncUser(b.userId)

    assert.deepEqual((await sharedRow(ctx.pool, 'assignments', 501)).deleted_at, built.clock.now())
    assert.equal((await sharedRow(ctx.pool, 'assignments', 502)).deleted_at, null)

    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { dueAt: DUE_A })])
    await built.lms.lmsSync.syncUser(a.userId)

    assert.equal((await sharedRow(ctx.pool, 'assignments', 501)).deleted_at, null)
    assert.deepEqual((await userLinks(ctx.pool, a.userId)).assignments, [{ id: 501, dueAt: DUE_A }])
  })

  it('과목이 A의 활성 수강에서 빠지면 A의 수강 · 그 과목의 과제 · 공지 연결을 지우고, B와 공유 행은 그대로', async () => {
    canvas.setCourses(TOKEN_A, [])

    await built.lms.lmsSync.syncUser(a.userId)

    assert.deepEqual(await userLinks(ctx.pool, a.userId), { courses: [], assignments: [], announcements: [] })
    assert.deepEqual((await userLinks(ctx.pool, b.userId)).courses, [101])
    assert.deepEqual((await userLinks(ctx.pool, b.userId)).announcements, [701])
    assert.equal(await ctx.countRows('courses'), 1)
  })

  it('공지: start_date = 지금 − 30일, end_date = 지금으로 과목마다 요청한다', async () => {
    const req = canvas.requestsWithToken(TOKEN_A).find((r) => r.path === '/api/v1/announcements')
    const now = built.clock.now().getTime()

    assert.equal(req.url.searchParams.get('start_date'), new Date(now - 30 * DAY_MS).toISOString())
    assert.equal(req.url.searchParams.get('end_date'), new Date(now).toISOString())
    assert.deepEqual(req.url.searchParams.getAll('context_codes[]'), ['course_101'])
  })

  it('공지: 기간 창 밖으로 밀려나 안 온 공지는 "사라짐"으로 보지 않고, 창 안에서 사라진 공지만 연결을 지운다', async () => {
    const firstPosted = new Date(built.clock.now().getTime() - DAY_MS).toISOString() // beforeEach에서 연결된 701의 게시 시각
    const recent = new Date(built.clock.now().getTime() + 25 * DAY_MS).toISOString()
    built.clock.advance(35 * DAY_MS) // 701은 이제 36일 전 게시 → 창 밖이라 Canvas가 돌려주지 않는다
    canvas.setAnnouncements(TOKEN_A, 101, [canvasAnnouncement(101, 701, { postedAt: firstPosted }), canvasAnnouncement(101, 702, { postedAt: recent })])
    await built.lms.lmsSync.syncUser(a.userId)
    assert.deepEqual((await userLinks(ctx.pool, a.userId)).announcements, [701, 702], '창 밖 701은 유지, 702 추가')

    canvas.setAnnouncements(TOKEN_A, 101, [])
    await built.lms.lmsSync.syncUser(a.userId)

    assert.deepEqual((await userLinks(ctx.pool, a.userId)).announcements, [701], '창 안의 702만 지운다')
  })

  it('정리 규칙: 긴 이름은 255자로, 다른 출처 링크는 NULL, 1 MiB 넘는 본문은 NULL, 미게시 과제는 제외 — 동기화는 성공', async () => {
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '가'.repeat(300) })])
    canvas.setAssignments(TOKEN_A, 101, [
      canvasAssignment(101, 501, { dueAt: DUE_A, htmlUrl: 'https://evil.test/phish' }),
      canvasAssignment(101, 503, { published: false }),
    ])
    canvas.setAnnouncements(TOKEN_A, 101, [canvasAnnouncement(101, 701, { postedAt: built.clock.now().toISOString(), message: 'a'.repeat(1024 * 1024 + 1) })])

    assert.deepEqual(await built.lms.lmsSync.syncUser(a.userId), { outcome: 'applied' })

    const [[course]] = await ctx.pool.query('SELECT name FROM courses')
    assert.equal(course.name, '가'.repeat(255))
    assert.equal((await sharedRow(ctx.pool, 'assignments', 501)).html_url, null)
    assert.equal(await sharedRow(ctx.pool, 'assignments', 503), null)
    assert.equal((await sharedRow(ctx.pool, 'announcements', 701)).body, null)
    assert.equal((await tokenRow(ctx.pool, a.userId)).status, 'ok')
  })

  it('링크는 같은 출처면 그대로 저장한다', async () => {
    assert.equal((await sharedRow(ctx.pool, 'assignments', 501)).html_url, `${CANVAS_BASE_URL}/courses/101/assignments/501`)
  })
})
