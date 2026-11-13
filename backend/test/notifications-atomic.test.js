import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasFailures } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, registerToken, holdRequests, TOKEN_A } from './helpers/lms-context.js'
import { changes, change, countNotifications, seenValues, FUTURE_1, FUTURE_2 } from './helpers/notification-context.js'

const ASSIGNMENTS_102 = '/api/v1/courses/102/assignments'

// 진짜 풀을 감싸, fault.match(sql)가 참인 트랜잭션 쿼리에서 예상 밖 DB 에러를 던진다 (query · execute 모두)
function createFaultyPool(pool, fault) {
  const guard = (target, method) => async (sql, params) => {
    if (fault.match?.(String(sql))) {
      throw Object.assign(new Error('injected failure'), { code: 'ER_INJECTED_FAILURE' })
    }
    return target[method](sql, params)
  }
  const wrapConnection = (connection) =>
    new Proxy(connection, {
      get(target, prop) {
        if (prop === 'query' || prop === 'execute') {
          return guard(target, prop)
        }
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  return {
    execute: (...args) => pool.execute(...args),
    query: (...args) => pool.query(...args),
    getConnection: async () => wrapConnection(await pool.getConnection()),
  }
}

// 4 · 6: 중복 없음 · 실패하거나 반영하지 않은 동기화는 아무것도 기록하지 않음 (ADR 0009 2절)
describe('알림 기록: 같은 트랜잭션 · 중복 없음', () => {
  let ctx
  let canvas
  let built
  let fault
  let a
  const changed = [change('assignment_due_changed', 'assignment:501', { beforeDueAt: FUTURE_1, afterDueAt: FUTURE_2 })]

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    fault = {}
    canvas = createFakeCanvas()
    built = buildLmsApp(ctx, { canvas, pool: createFaultyPool(ctx.pool, fault) })
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101), canvasCourse(102)])
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1', dueAt: FUTURE_1 })])
    canvas.setAssignments(TOKEN_A, 102, [canvasAssignment(102, 601, { dueAt: FUTURE_1 })])
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1', dueAt: FUTURE_2 })])
  })
  after(async () => {
    await ctx.close()
  })

  const sync = () => built.lms.lmsSync.syncUser(a.userId)

  it('4. 같은 사용자 동시 동기화 2번 → 하나는 already_running, 알림 1건', async () => {
    const hold = holdRequests(canvas, (r) => r.path === ASSIGNMENTS_102)
    let results
    try {
      const first = sync()
      await hold.reached
      const second = await sync()
      hold.release()
      results = [await first, second]
    } finally {
      hold.release()
    }

    assert.deepEqual(results.map((r) => r.outcome).sort(), ['applied', 'skipped'])
    assert.deepEqual(await changes(ctx.pool, a.userId), changed)
  })

  it('4. 주기 실행 중 수동 요청(끝나길 기다렸다 한 번 더) → 두 번째는 변경 없음, 알림 1건', async () => {
    const hold = holdRequests(canvas, (r) => r.path === ASSIGNMENTS_102)
    try {
      const run = built.lms.syncRunner.runOnce()
      await hold.reached
      built.lms.syncRunner.requestSync(a.userId)
      hold.release()
      await run
    } finally {
      hold.release()
    }
    await built.lms.syncRunner.whenIdle()

    assert.deepEqual(await changes(ctx.pool, a.userId), changed)
  })

  it('6. Canvas 요청이 중간에 실패 → 알림 0건 · 본 값 그대로, 회복 뒤 재시도 → 1건', async () => {
    const seenBefore = await seenValues(ctx.pool, a.userId)
    canvas.intercept((r) => r.path === ASSIGNMENTS_102, () => canvasFailures.serverError(), { times: 1 })

    assert.equal((await sync()).outcome, 'failed')
    assert.equal(await countNotifications(ctx.pool), 0)
    assert.deepEqual(await seenValues(ctx.pool, a.userId), seenBefore)

    assert.equal((await sync()).outcome, 'applied')
    assert.deepEqual(await changes(ctx.pool, a.userId), changed)
  })

  it('6. 알림을 넣은 뒤 반영 마지막 단계(토큰 상태 갱신)에서 DB 에러 → 알림 0건 · 본 값 그대로(롤백), 재시도 → 1건', async () => {
    const seenBefore = await seenValues(ctx.pool, a.userId)
    fault.match = (sql) => /^\s*UPDATE lms_tokens/.test(sql)

    assert.equal((await sync()).outcome, 'failed')
    assert.equal(await countNotifications(ctx.pool), 0)
    assert.deepEqual(await seenValues(ctx.pool, a.userId), seenBefore)

    fault.match = null
    assert.equal((await sync()).outcome, 'applied')
    assert.deepEqual(await changes(ctx.pool, a.userId), changed)
  })

  it('6. 알림 넣기에서 DB 에러 → 연결 · 본 값도 반영하지 않음, 재시도 → 1건', async () => {
    const seenBefore = await seenValues(ctx.pool, a.userId)
    fault.match = (sql) => /notifications/.test(sql) && /^\s*(INSERT|UPDATE)/.test(sql)

    assert.equal((await sync()).outcome, 'failed')
    assert.deepEqual(await seenValues(ctx.pool, a.userId), seenBefore)

    fault.match = null
    await sync()
    assert.deepEqual(await changes(ctx.pool, a.userId), changed)
  })

  it('반영 직전 토큰이 바뀜(재등록) → 그 동기화는 버려 기록 없음, 재등록이 부른 동기화가 1건만 기록', async () => {
    const hold = holdRequests(canvas, (r) => r.path === ASSIGNMENTS_102)
    let first
    try {
      first = sync()
      await hold.reached
      await registerToken(a.agent, TOKEN_A).expect(202)
      hold.release()
      assert.deepEqual(await first, { outcome: 'skipped', reason: 'token_changed' })
    } finally {
      hold.release()
    }
    await built.lms.syncRunner.whenIdle()

    assert.deepEqual(await changes(ctx.pool, a.userId), changed)
  })
})
