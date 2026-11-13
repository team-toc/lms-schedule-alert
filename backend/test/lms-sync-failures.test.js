import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasFailures } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, registerToken, tokenRow, userLinks, snapshotLmsTables, holdRequests, TOKEN_PATH, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'

function withoutTokens(snapshot) {
  const { lms_tokens: _ignored, ...rest } = snapshot
  return rest
}

describe('동기화: 401 · 요청 제한 · 같은 사용자 동시 실행', () => {
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
    for (const [token, id] of [
      [TOKEN_A, 9001],
      [TOKEN_B, 9002],
    ]) {
      canvas.addAccount(token, { id })
      canvas.setCourses(token, [canvasCourse(101), canvasCourse(102)])
      canvas.setAssignments(token, 101, [canvasAssignment(101, 501, { dueAt: '2026-11-20T00:00:00Z' })])
    }
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
    // 이후 Canvas 쪽 변경: 반영되면 501이 사라지고 502가 생긴다
    for (const token of [TOKEN_A, TOKEN_B]) {
      canvas.setAssignments(token, 101, [canvasAssignment(101, 502, { dueAt: '2026-11-25T00:00:00Z' })])
    }
  })
  after(async () => {
    await ctx.close()
  })

  it('9. 401(WWW-Authenticate, 토큰 만료 · 취소) → 반영 없음, needs_reauth, 주기 실행에서 빠진다(그 토큰으로 요청 없음)', async () => {
    const before = await snapshotLmsTables(ctx.pool)
    canvas.intercept((r) => r.token === TOKEN_A, canvasFailures.unauthorized)

    assert.deepEqual(await built.lms.lmsSync.syncUser(a.userId), { outcome: 'failed', errorCode: 'canvas_unauthorized' })

    assert.deepEqual(withoutTokens(await snapshotLmsTables(ctx.pool)), withoutTokens(before))
    const row = await tokenRow(ctx.pool, a.userId)
    assert.equal(row.status, 'needs_reauth')
    assert.equal(row.last_error_code, 'canvas_unauthorized')

    const requestsBefore = canvas.requestsWithToken(TOKEN_A).length
    await built.lms.syncRunner.runOnce()

    assert.equal(canvas.requestsWithToken(TOKEN_A).length, requestsBefore, 'needs_reauth 사용자는 주기 실행에서 제외')
    assert.deepEqual((await userLinks(ctx.pool, b.userId)).assignments.map((x) => x.id), [502], '다른 사용자는 그대로 동기화된다')
  })

  it('9. needs_reauth 사용자가 토큰을 다시 등록하면 syncing → ok, 주기 실행에 다시 들어간다', async () => {
    canvas.intercept((r) => r.token === TOKEN_A, canvasFailures.unauthorized, { times: 1 })
    await built.lms.lmsSync.syncUser(a.userId)

    await registerToken(a.agent, TOKEN_A).expect(202)
    await built.lms.syncRunner.whenIdle()

    assert.equal((await tokenRow(ctx.pool, a.userId)).status, 'ok')
    canvas.setAssignments(TOKEN_A, 101, [])
    await built.lms.syncRunner.runOnce()
    assert.deepEqual((await userLinks(ctx.pool, a.userId)).assignments, [])
  })

  it('WWW-Authenticate 없는 401 · 일반 403은 권한 문제: failing · canvas_forbidden, 주기 실행에는 계속 포함', async () => {
    for (const respond of [canvasFailures.unauthorizedWithoutChallenge, canvasFailures.forbidden]) {
      canvas.clearIntercepts()
      canvas.intercept((r) => r.token === TOKEN_A && r.path === '/api/v1/courses/102/assignments', respond)

      assert.deepEqual(await built.lms.lmsSync.syncUser(a.userId), { outcome: 'failed', errorCode: 'canvas_forbidden' })
      assert.equal((await tokenRow(ctx.pool, a.userId)).status, 'failing')
    }
    canvas.clearIntercepts()
    await built.lms.syncRunner.runOnce()
    assert.equal((await tokenRow(ctx.pool, a.userId)).status, 'ok')
  })

  for (const [label, respond] of [
    ['429', canvasFailures.rateLimited429],
    ['403 + "Rate Limit Exceeded"', canvasFailures.rateLimited403],
  ]) {
    it(`10. 요청 제한(${label}) → 그 사용자 동기화를 바로 멈추고(다음 요청 없음) 반영 없음, 다음 주기에 재시도해 반영`, async () => {
      const before = await snapshotLmsTables(ctx.pool)
      canvas.intercept((r) => r.token === TOKEN_A && r.path === '/api/v1/courses/101/assignments', respond)
      const requestsBefore = canvas.requestsWithToken(TOKEN_A).length

      assert.deepEqual(await built.lms.lmsSync.syncUser(a.userId), { outcome: 'failed', errorCode: 'canvas_rate_limited' })

      const made = canvas.requestsWithToken(TOKEN_A).slice(requestsBefore)
      assert.equal(made.at(-1).path, '/api/v1/courses/101/assignments', '제한 응답 뒤로 요청을 더 보내지 않는다')
      assert.deepEqual(withoutTokens(await snapshotLmsTables(ctx.pool)), withoutTokens(before))
      const row = await tokenRow(ctx.pool, a.userId)
      assert.equal(row.status, 'failing')
      assert.equal(row.last_error_code, 'canvas_rate_limited')

      canvas.clearIntercepts()
      await built.lms.syncRunner.runOnce()

      assert.equal((await tokenRow(ctx.pool, a.userId)).status, 'ok')
      assert.deepEqual((await userLinks(ctx.pool, a.userId)).assignments.map((x) => x.id), [502])
    })
  }

  it('7. 같은 사용자 동기화를 동시에 두 번 → 하나만 실행 · 반영되고 다른 하나는 건너뛴다, 중복 행 없음', async () => {
    const hold = holdRequests(canvas, (r) => r.token === TOKEN_A && r.path === '/api/v1/courses')
    const first = built.lms.lmsSync.syncUser(a.userId)
    await hold.reached
    const coursesRequests = () => canvas.requestsWithToken(TOKEN_A).filter((r) => r.path === '/api/v1/courses').length
    const requestedBefore = coursesRequests()

    const second = await built.lms.lmsSync.syncUser(a.userId)
    hold.release()

    assert.deepEqual(second, { outcome: 'skipped', reason: 'already_running' })
    assert.deepEqual(await first, { outcome: 'applied' })
    assert.equal(coursesRequests(), requestedBefore, '두 번째는 Canvas를 부르지 않는다')
    assert.deepEqual((await userLinks(ctx.pool, a.userId)).assignments.map((x) => x.id), [502])
    const [[{ n }]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM user_assignments WHERE user_id = ?', [a.userId])
    assert.equal(Number(n), 1)
  })

  it('7. 다른 사용자는 동시에 동기화된다 (잠금은 사용자별)', async () => {
    const hold = holdRequests(canvas, (r) => r.token === TOKEN_A && r.path === '/api/v1/courses')
    const first = built.lms.lmsSync.syncUser(a.userId)
    await hold.reached

    assert.deepEqual(await built.lms.lmsSync.syncUser(b.userId), { outcome: 'applied' })
    hold.release()
    assert.deepEqual(await first, { outcome: 'applied' })
  })

  it('동기화 도중 토큰이 삭제되면 반영하지 않는다 (연결 · 토큰 행 없음)', async () => {
    const hold = holdRequests(canvas, (r) => r.token === TOKEN_A && r.path === '/api/v1/courses/101/assignments')
    const running = built.lms.lmsSync.syncUser(a.userId)
    await hold.reached

    await a.agent.delete(TOKEN_PATH).expect(204)
    hold.release()

    assert.deepEqual(await running, { outcome: 'skipped', reason: 'token_changed' })
    assert.equal(await tokenRow(ctx.pool, a.userId), null)
    assert.deepEqual(await userLinks(ctx.pool, a.userId), { courses: [], assignments: [], announcements: [] })
  })

  it('동기화 도중 토큰이 교체되면 옛 토큰으로 받은 결과는 반영하지 않는다', async () => {
    const hold = holdRequests(canvas, (r) => r.token === TOKEN_A && r.path === '/api/v1/courses/101/assignments')
    const running = built.lms.lmsSync.syncUser(a.userId)
    await hold.reached
    canvas.addAccount('7~ReplacementToken0123456789', { id: 9001 })

    await registerToken(a.agent, '7~ReplacementToken0123456789').expect(202)
    hold.release()

    assert.deepEqual(await running, { outcome: 'skipped', reason: 'token_changed' })
    // 등록이 요청한 첫 동기화는 옛 동기화가 잠금을 쥐고 있어 바로 못 돌았더라도, 끝난 뒤 새 토큰으로 이어서 돈다
    await built.lms.syncRunner.whenIdle()
    assert.equal((await tokenRow(ctx.pool, a.userId)).status, 'ok')
    assert.deepEqual((await userLinks(ctx.pool, a.userId)).courses, [], '새 토큰(과목 없음) 기준으로 반영')
  })
})
