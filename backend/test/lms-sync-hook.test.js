import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasFailures } from './helpers/fake-canvas.js'
import { signedInUser, registerToken, holdRequests, TOKEN_A, TOKEN_PATH } from './helpers/lms-context.js'
import { buildSuggestionApp } from './helpers/suggestion-context.js'

const ASSIGNMENTS_101 = '/api/v1/courses/101/assignments'

// Canvas 반영 뒤 훅 (ADR 0011 리뷰 결정 2): 반영이 실제로 커밋됐을 때만, 같은 사용자 잠금 안에서, 훅 에러는 Canvas 결과를 바꾸지 않음
describe('Canvas 동기화 afterApplied 훅', () => {
  let ctx
  let canvas
  let built
  let calls
  let hook
  let lines

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    calls = []
    hook = async (input) => {
      calls.push(input)
    }
    lines = []
    canvas = createFakeCanvas()
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101)])
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501)])
    built = buildSuggestionApp(ctx, {
      canvas,
      afterCanvasApplied: (input) => hook(input),
      logger: pino({ level: 'trace' }, { write: (line) => lines.push(line) }),
    })
  })
  after(async () => {
    await ctx.close()
  })

  async function connect() {
    const user = await signedInUser(built.app, 'a@example.com')
    await registerToken(user.agent, TOKEN_A).expect(202)
    await built.lms.syncRunner.whenIdle()
    return user
  }

  it('반영이 커밋되면 한 번, { userId, at }로 (변화 없는 재동기화도 반영이 커밋되므로 부른다)', async () => {
    const a = await connect()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].userId, a.userId)
    assert.equal(calls[0].at.toISOString(), built.clock.now().toISOString())

    assert.equal((await built.lms.lmsSync.syncUser(a.userId)).outcome, 'applied')
    assert.equal(calls.length, 2)
  })

  it('Canvas 실패(500 · 401)로 반영하지 않으면 부르지 않는다', async () => {
    const a = await connect()
    calls.length = 0
    canvas.intercept((r) => r.path === ASSIGNMENTS_101, () => canvasFailures.serverError(), { times: 1 })
    assert.equal((await built.lms.lmsSync.syncUser(a.userId)).outcome, 'failed')
    canvas.intercept(() => true, () => canvasFailures.unauthorized(), { times: 1 })
    assert.equal((await built.lms.lmsSync.syncUser(a.userId)).outcome, 'failed')

    assert.deepEqual(calls, [])
  })

  it('반영 직전 토큰이 바뀌어 결과를 버리면(token_changed) 그 동기화는 부르지 않는다', async () => {
    const a = await connect()
    calls.length = 0
    const held = holdRequests(canvas, (r) => r.path === ASSIGNMENTS_101)
    let first
    try {
      first = built.lms.lmsSync.syncUser(a.userId)
      await held.reached
      await registerToken(a.agent, TOKEN_A).expect(202)
      held.release()
      assert.deepEqual(await first, { outcome: 'skipped', reason: 'token_changed' })
    } finally {
      held.release()
    }
    await built.lms.syncRunner.whenIdle()

    assert.equal(calls.length, 1, '버린 동기화는 0번, 재등록이 부른 동기화만 1번')
  })

  it('연결이 없으면(not_connected) · 이미 실행 중이라 건너뛰면(already_running) 부르지 않는다', async () => {
    const a = await connect()
    await a.agent.delete(TOKEN_PATH).expect(204)
    calls.length = 0
    assert.deepEqual(await built.lms.lmsSync.syncUser(a.userId), { outcome: 'skipped', reason: 'not_connected' })
    assert.deepEqual(calls, [])

    await registerToken(a.agent, TOKEN_A).expect(202)
    await built.lms.syncRunner.whenIdle()
    calls.length = 0
    const held = holdRequests(canvas, (r) => r.path === ASSIGNMENTS_101)
    try {
      const first = built.lms.lmsSync.syncUser(a.userId)
      await held.reached
      assert.deepEqual(await built.lms.lmsSync.syncUser(a.userId), { outcome: 'skipped', reason: 'already_running' })
      held.release()
      await first
    } finally {
      held.release()
    }
    assert.equal(calls.length, 1, '실행된 동기화 하나만')
  })

  it('훅은 같은 사용자 잠금 안에서 돈다: 훅이 끝나기 전 같은 사용자 동기화는 already_running', async () => {
    const a = await connect()
    let releaseHook
    let markEntered
    const entered = new Promise((resolve) => {
      markEntered = resolve
    })
    hook = () => {
      markEntered()
      return new Promise((resolve) => {
        releaseHook = resolve
      })
    }
    const first = built.lms.lmsSync.syncUser(a.userId)
    await entered
    try {
      assert.deepEqual(await built.lms.lmsSync.syncUser(a.userId), { outcome: 'skipped', reason: 'already_running' })
    } finally {
      releaseHook()
    }
    assert.equal((await first).outcome, 'applied')
  })

  it('훅이 던져도 Canvas 결과는 applied 그대로, 코드만 로그(메시지 없음), 처리되지 않은 거부 없음', async () => {
    const a = await connect()
    hook = async () => {
      throw Object.assign(new Error('hook exploded MUST-NOT-LOG'), { code: 'ER_HOOK' })
    }

    const result = await built.lms.lmsSync.syncUser(a.userId)

    assert.equal(result.outcome, 'applied')
    const failed = lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'lms_after_applied_failed')
    assert.equal(failed.length, 1)
    assert.deepEqual(failed[0].err, { name: 'Error', code: 'ER_HOOK' })
    assert.ok(!lines.join('\n').includes('MUST-NOT-LOG'))
  })
})
