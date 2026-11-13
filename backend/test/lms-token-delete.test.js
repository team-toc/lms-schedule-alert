import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasAnnouncement } from './helpers/fake-canvas.js'
import { buildLmsApp, signedInUser, connectUser, tokenRow, onboardingStep, userLinks, TOKEN_PATH, STATUS_PATH, DAY_MS, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'

const SHARED_TABLES = ['courses', 'assignments', 'announcements']

async function sharedRows(pool) {
  const rows = {}
  for (const table of SHARED_TABLES) {
    const [result] = await pool.query('SELECT * FROM ?? ORDER BY id', [table])
    rows[table] = result.map((row) => ({ ...row }))
  }
  return rows
}

describe('15. DELETE /api/lms/token (연동 해제)', () => {
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
    for (const [token, id] of [
      [TOKEN_A, 9001],
      [TOKEN_B, 9002],
    ]) {
      canvas.addAccount(token, { id })
      canvas.setCourses(token, [canvasCourse(101)])
      canvas.setAssignments(token, 101, [canvasAssignment(101, 501, { dueAt: '2026-11-20T00:00:00Z' })])
      canvas.setAnnouncements(token, 101, [canvasAnnouncement(101, 701, { postedAt: posted })])
    }
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
  })
  after(async () => {
    await ctx.close()
  })

  it('204, 그 사용자의 토큰 · 수강 · 과제 연결 · 공지 연결만 지우고 공유 행과 다른 사용자 연결은 그대로', async () => {
    const sharedBefore = await sharedRows(ctx.pool)
    const linksOfB = await userLinks(ctx.pool, b.userId)

    await a.agent.delete(TOKEN_PATH).expect(204)

    assert.equal(await tokenRow(ctx.pool, a.userId), null)
    assert.deepEqual(await userLinks(ctx.pool, a.userId), { courses: [], assignments: [], announcements: [] })
    assert.deepEqual(await userLinks(ctx.pool, b.userId), linksOfB)
    assert.ok(await tokenRow(ctx.pool, b.userId))
    assert.deepEqual(await sharedRows(ctx.pool), sharedBefore)
  })

  it('마지막 사용자가 해제해도 공유 행은 남는다', async () => {
    await a.agent.delete(TOKEN_PATH).expect(204)
    await b.agent.delete(TOKEN_PATH).expect(204)

    for (const table of SHARED_TABLES) {
      assert.equal(await ctx.countRows(table), 1, table)
    }
    for (const table of ['lms_tokens', 'enrollments', 'user_assignments', 'user_announcements']) {
      assert.equal(await ctx.countRows(table), 0, table)
    }
  })

  it('onboarding_step을 lms_token으로 되돌리고, 상태는 not_connected', async () => {
    await a.agent.delete(TOKEN_PATH).expect(204)

    assert.equal(await onboardingStep(ctx.pool, a.userId), 'lms_token')
    assert.deepEqual((await a.agent.get(STATUS_PATH).expect(200)).body, { status: 'not_connected' })
    assert.equal(await onboardingStep(ctx.pool, b.userId), 'done')
  })

  it('해제한 사용자는 주기 실행에서 빠진다 (그 토큰으로 Canvas 요청 없음)', async () => {
    await a.agent.delete(TOKEN_PATH).expect(204)
    const before = canvas.requestsWithToken(TOKEN_A).length

    await built.lms.syncRunner.runOnce()

    assert.equal(canvas.requestsWithToken(TOKEN_A).length, before)
  })

  it('연결이 없으면 404 lms_not_connected', async () => {
    const { agent } = await signedInUser(built.app, 'c@example.com')

    const res = await agent.delete(TOKEN_PATH).expect(404)

    assert.equal(res.body.error, 'lms_not_connected')
  })

  it('사용자(계정)를 지우면 토큰 · 연결이 CASCADE로 지워지고 공유 행은 남는다', async () => {
    await ctx.pool.execute('DELETE FROM users WHERE id = ?', [a.userId])

    assert.equal(await tokenRow(ctx.pool, a.userId), null)
    assert.deepEqual(await userLinks(ctx.pool, a.userId), { courses: [], assignments: [], announcements: [] })
    assert.equal(await ctx.countRows('assignments'), 1)
  })
})
