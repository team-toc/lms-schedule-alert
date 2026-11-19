import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasAnnouncement } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, DAY_MS, MINUTE_MS, TOKEN_A } from './helpers/lms-context.js'
import { changes, change, countNotifications, notificationRows, FUTURE_1, FUTURE_2, PAST_1, PAST_2 } from './helpers/notification-context.js'

// 의미 없는 알림 줄이기 · 새 과목 기준 동기화 · 안 읽은 알림 합치기 (ADR 0009 3 · 6절, 가정 절)
describe('알림 규칙: 지난 과제 · 수강 변화 · 합치기', () => {
  let ctx
  let canvas
  let built
  let a
  const set = (list) => canvas.setAssignments(TOKEN_A, 101, list)
  const item = (id, dueAt, name = `과제 ${id}`) => canvasAssignment(101, id, { name, dueAt })

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    canvas = createFakeCanvas()
    built = buildLmsApp(ctx, { canvas })
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '자료구조' })])
    set([item(501, PAST_1), item(502, FUTURE_1), item(503, null)])
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
  })
  after(async () => {
    await ctx.close()
  })

  const sync = async () => {
    built.clock.advance(MINUTE_MS)
    return built.lms.lmsSync.syncUser(a.userId)
  }

  describe('지난 과제', () => {
    const cases = [
      ['지난 마감끼리 바뀜 → 알리지 않음', [item(501, PAST_2), item(502, FUTURE_1), item(503, null)], []],
      ['지난 마감 → 미래(연장) → 알림', [item(501, FUTURE_2), item(502, FUTURE_1), item(503, null)], [change('assignment_due_changed', 'assignment:501', { beforeDueAt: PAST_1, afterDueAt: FUTURE_2 })]],
      ['미래 → 지난 마감(앞당김) → 알림', [item(501, PAST_1), item(502, PAST_2), item(503, null)], [change('assignment_due_changed', 'assignment:502', { beforeDueAt: FUTURE_1, afterDueAt: PAST_2 })]],
      ['지난 마감 → 없음 → 알리지 않음', [item(501, null), item(502, FUTURE_1), item(503, null)], []],
      ['새 과제인데 마감이 이미 지남 → 알리지 않음', [item(501, PAST_1), item(502, FUTURE_1), item(503, null), item(504, PAST_2)], []],
      ['마감 없는 새 과제 → 알림', [item(501, PAST_1), item(502, FUTURE_1), item(503, null), item(504, null)], [change('assignment_created', 'assignment:504')]],
      ['지난 과제가 사라짐 → 알리지 않음', [item(502, FUTURE_1), item(503, null)], []],
      ['마감 없는 과제가 사라짐 → 알림', [item(501, PAST_1), item(502, FUTURE_1)], [change('assignment_removed', 'assignment:503')]],
      ['지난 과제의 제목만 바뀜 → 알리지 않음', [item(501, PAST_1, '바뀐 제목'), item(502, FUTURE_1), item(503, null)], []],
    ]
    for (const [label, next, expected] of cases) {
      it(label, async () => {
        set(next)
        await sync()
        assert.deepEqual(await changes(ctx.pool, a.userId), expected)
      })
    }
  })

  it('과목이 활성 수강에서 빠져 생긴 "사라짐"은 알리지 않는다 (마감이 미래여도)', async () => {
    canvas.setCourses(TOKEN_A, [])

    await sync()

    assert.equal(await countNotifications(ctx.pool), 0)
  })

  it('새로 수강 목록에 나타난 과목은 그 과목만 기준 동기화(0건), 같은 동기화의 기존 과목 변경은 알림, 다음 동기화부터 새 과목도 감지', async () => {
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '자료구조' }), canvasCourse(102, { name: '운영체제' })])
    canvas.setAssignments(TOKEN_A, 102, [canvasAssignment(102, 601, { dueAt: FUTURE_1 }), canvasAssignment(102, 602, { dueAt: FUTURE_2 })])
    canvas.setAnnouncements(TOKEN_A, 102, [canvasAnnouncement(102, 801, { postedAt: new Date(built.clock.now().getTime() - DAY_MS).toISOString() })])
    set([item(501, PAST_1), item(502, FUTURE_2), item(503, null)])

    await sync()
    assert.deepEqual((await changes(ctx.pool, a.userId)).map((c) => c.target), ['assignment:502'], '새 과목 과제 · 공지는 알리지 않음')

    canvas.setAssignments(TOKEN_A, 102, [canvasAssignment(102, 601, { dueAt: FUTURE_2 }), canvasAssignment(102, 602, { dueAt: FUTURE_2 })])
    await sync()
    assert.deepEqual((await changes(ctx.pool, a.userId)).at(-1), change('assignment_due_changed', 'assignment:601', { beforeDueAt: FUTURE_1, afterDueAt: FUTURE_2 }))
    assert.equal(await countNotifications(ctx.pool), 2)
  })

  it('빠졌다가 다시 나타난 과목도 새 과목으로 보고 기준 동기화 (0건)', async () => {
    canvas.setCourses(TOKEN_A, [])
    await sync()
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '자료구조' })])
    set([item(501, PAST_1), item(502, FUTURE_2), item(503, null), item(504, FUTURE_1)])

    await sync()

    assert.equal(await countNotifications(ctx.pool), 0)
  })

  it('합치기: 안 읽은 마감 변경이 또 바뀌면 1건으로 (전 = 처음 값, 후 = 마지막 값), 자리(id)는 그대로 · 감지 시각만 새로', async () => {
    set([item(501, PAST_1), item(502, FUTURE_2), item(503, null)])
    await sync()
    const [first] = await notificationRows(ctx.pool, a.userId)
    set([item(501, PAST_1), item(502, '2026-12-04T14:59:00.000Z'), item(503, null)])

    await sync()

    const rows = await notificationRows(ctx.pool, a.userId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, first.id)
    assert.deepEqual([rows[0].beforeDueAt, rows[0].afterDueAt], [FUTURE_1, '2026-12-04T14:59:00.000Z'])
    assert.equal(rows[0].detectedAt, built.clock.now().toISOString())
  })

  it('합치기: 원래 값으로 되돌아가면(전 = 후) 안 읽은 알림을 지운다', async () => {
    set([item(501, PAST_1), item(502, FUTURE_2), item(503, null)])
    await sync()
    set([item(501, PAST_1), item(502, FUTURE_1), item(503, null)])

    await sync()

    assert.equal(await countNotifications(ctx.pool), 0)
  })

  it('읽은 알림은 합치지 않는다: 읽은 뒤 또 바뀌면 새 알림', async () => {
    set([item(501, PAST_1), item(502, FUTURE_2), item(503, null)])
    await sync()
    await ctx.pool.query('UPDATE notifications SET read_at = detected_at')
    set([item(501, PAST_1), item(502, FUTURE_1), item(503, null)])

    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [
      change('assignment_due_changed', 'assignment:502', { beforeDueAt: FUTURE_1, afterDueAt: FUTURE_2 }),
      change('assignment_due_changed', 'assignment:502', { beforeDueAt: FUTURE_2, afterDueAt: FUTURE_1 }),
    ])
  })

  it('사라진 과제가 다시 나타나면 안 읽은 "사라짐"을 지우고 "새 과제"도 만들지 않는다 (되돌림)', async () => {
    set([item(501, PAST_1), item(503, null)])
    await sync()
    assert.equal(await countNotifications(ctx.pool), 1)
    set([item(501, PAST_1), item(502, FUTURE_1), item(503, null)])

    await sync()

    assert.equal(await countNotifications(ctx.pool), 0)
  })

  it('공지가 시간이 지나 기간 창(30일) 밖으로 밀려나도 알리지 않는다 (공지 사라짐 없음)', async () => {
    canvas.setAnnouncements(TOKEN_A, 101, [canvasAnnouncement(101, 701, { postedAt: new Date(built.clock.now().getTime() - DAY_MS).toISOString() })])
    await sync()
    const afterCreated = await countNotifications(ctx.pool)

    built.clock.advance(31 * DAY_MS)
    await sync()

    assert.equal(afterCreated, 1)
    assert.equal(await countNotifications(ctx.pool), 1)
  })
})
