import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'
import { changes, change, countNotifications, FUTURE_1, FUTURE_2 } from './helpers/notification-context.js'

// 공유 과제 행 · 사용자별 마감 · 사용자별 본 값 (ADR 0009 1절): 알림은 동기화한 그 사용자에게만, 각자 자기 본 값과 비교
describe('알림 범위: 사용자마다 따로', () => {
  let ctx
  let canvas
  let built
  let a
  let b
  const assignment = (fields) => canvasAssignment(101, 501, { name: '과제 1', dueAt: FUTURE_1, ...fields })

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
      canvas.setCourses(token, [canvasCourse(101, { name: '자료구조' })])
      canvas.setAssignments(token, 101, [assignment()])
    }
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
  })
  after(async () => {
    await ctx.close()
  })

  const syncBoth = async () => {
    await built.lms.lmsSync.syncUser(a.userId)
    await built.lms.lmsSync.syncUser(b.userId)
  }

  it('5. A의 마감만 바뀌면(개인 연장) A만 1건, B는 둘 다 동기화해도 0건', async () => {
    canvas.setAssignments(TOKEN_A, 101, [assignment({ dueAt: FUTURE_2 })])

    await syncBoth()

    assert.deepEqual(await changes(ctx.pool, a.userId), [change('assignment_due_changed', 'assignment:501', { beforeDueAt: FUTURE_1, afterDueAt: FUTURE_2 })])
    assert.equal(await countNotifications(ctx.pool, b.userId), 0)
  })

  it('공유 제목이 바뀌면 A의 동기화는 A의 알림만 만들고, 나중에 동기화한 B도 자기 본 제목과 비교해 1건 받는다', async () => {
    for (const token of [TOKEN_A, TOKEN_B]) {
      canvas.setAssignments(token, 101, [assignment({ name: '과제 1 (수정)' })])
    }

    await built.lms.lmsSync.syncUser(a.userId)
    assert.equal(await countNotifications(ctx.pool, a.userId), 1)
    assert.equal(await countNotifications(ctx.pool, b.userId), 0, 'A의 동기화가 B의 알림을 만들지 않음')

    await built.lms.lmsSync.syncUser(b.userId)
    const expected = [change('assignment_title_changed', 'assignment:501', { beforeTitle: '과제 1', afterTitle: '과제 1 (수정)' })]
    assert.deepEqual(await changes(ctx.pool, b.userId), expected, '공유 행은 이미 새 제목이지만 B가 본 제목은 이전 값')
    assert.deepEqual(await changes(ctx.pool, a.userId), expected)
  })

  it('A에게만 새로 보이는 과제 → A만 새 과제 1건', async () => {
    canvas.setAssignments(TOKEN_A, 101, [assignment(), canvasAssignment(101, 502, { dueAt: FUTURE_2 })])

    await syncBoth()

    assert.deepEqual((await changes(ctx.pool, a.userId)).map((c) => c.kind), ['assignment_created'])
    assert.equal(await countNotifications(ctx.pool, b.userId), 0)
  })

  it('A에게서만 사라진 과제 → A만 사라짐 1건 (B의 연결 · 마감은 그대로)', async () => {
    canvas.setAssignments(TOKEN_A, 101, [])

    await syncBoth()

    assert.deepEqual((await changes(ctx.pool, a.userId)).map((c) => c.kind), ['assignment_removed'])
    assert.equal(await countNotifications(ctx.pool, b.userId), 0)
  })
})
