import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasAnnouncement } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, tokenRow, DAY_MS, TOKEN_A } from './helpers/lms-context.js'
import { changes, change, countNotifications, notificationRows, seenValues, FUTURE_1, FUTURE_2 } from './helpers/notification-context.js'

// 변경 감지 (ADR 0009): 첫 동기화는 기준(알림 0), 재동기화 0, 종류마다 정확히 1건 + 전/후 값
describe('변경 감지: 첫 동기화 · 재동기화 · 종류별 1건', () => {
  let ctx
  let canvas
  let built
  let a
  let posted
  const assignments = () => [canvasAssignment(101, 501, { name: '과제 1', dueAt: FUTURE_1 }), canvasAssignment(101, 502, { name: '과제 2', dueAt: FUTURE_1 })]
  const announcement = (fields = {}) => canvasAnnouncement(101, 701, { title: '공지 1', message: '<p>원래 본문</p>', postedAt: posted, ...fields })

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    canvas = createFakeCanvas()
    built = buildLmsApp(ctx, { canvas })
    posted = new Date(built.clock.now().getTime() - DAY_MS).toISOString()
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '자료구조' })])
    canvas.setAssignments(TOKEN_A, 101, assignments())
    canvas.setAnnouncements(TOKEN_A, 101, [announcement()])
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
  })
  after(async () => {
    await ctx.close()
  })

  const sync = () => built.lms.lmsSync.syncUser(a.userId)

  it('1. 첫 동기화(기준 동기화)는 알림 0건, 본 값(제목 · 공지 해시)은 채운다', async () => {
    assert.equal(await countNotifications(ctx.pool), 0)
    const seen = await seenValues(ctx.pool, a.userId)
    assert.deepEqual(seen.assignments, [
      { id: 501, title: '과제 1', dueAt: FUTURE_1 },
      { id: 502, title: '과제 2', dueAt: FUTURE_1 },
    ])
    assert.equal(seen.announcements[0].title, '공지 1')
    assert.match(seen.announcements[0].hash, /^[0-9a-f]{64}$/)
  })

  // 첫 동기화는 모든 과목이 "새 수강"이라 새 과목 규칙으로도 조용하다. 수강이 이미 있는 상태의 기준 동기화는 이 테스트가 확인한다
  it('기준 동기화 표시(baseline_required = 1, 마이그레이션 전 행 · 다른 계정 교체)가 있으면 수강이 그대로여도 0건, 그다음부터 감지', async () => {
    await ctx.pool.query('UPDATE lms_tokens SET baseline_required = 1, canvas_user_id = NULL WHERE user_id = ?', [a.userId])
    await ctx.pool.query('UPDATE user_assignments SET seen_title = NULL')
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1 (수정)', dueAt: FUTURE_2 }), assignments()[1]])

    await sync()
    assert.equal(await countNotifications(ctx.pool), 0)
    assert.equal((await tokenRow(ctx.pool, a.userId)).baseline_required, 0, '반영하면 같은 트랜잭션에서 FALSE')

    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1 (수정)', dueAt: FUTURE_1 }), assignments()[1]])
    await sync()
    assert.deepEqual((await changes(ctx.pool, a.userId)).map((c) => c.kind), ['assignment_due_changed'])
  })

  it('3. 변경 없이 다시 동기화하면 0건 (여러 번 해도)', async () => {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await sync()).outcome, 'applied')
    }
    assert.equal(await countNotifications(ctx.pool), 0)
  })

  it('새 과제 → assignment_created 1건 (전: 없음, 후: 마감)', async () => {
    built.clock.advance(60 * 1000)
    canvas.setAssignments(TOKEN_A, 101, [...assignments(), canvasAssignment(101, 503, { name: '과제 3', dueAt: FUTURE_2 })])

    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [change('assignment_created', 'assignment:503', { afterDueAt: FUTURE_2 })])
    const [row] = await notificationRows(ctx.pool, a.userId)
    assert.equal(row.detectedAt, built.clock.now().toISOString(), '감지 시각 = 그 동기화 시각')
    assert.equal(row.read, false)
  })

  it('마감 변경 → assignment_due_changed 1건 (전 · 후 마감)', async () => {
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1', dueAt: FUTURE_2 }), assignments()[1]])

    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [change('assignment_due_changed', 'assignment:501', { beforeDueAt: FUTURE_1, afterDueAt: FUTURE_2 })])
  })

  it('마감이 없어짐(값 → NULL) · 생김(NULL → 값)도 마감 변경', async () => {
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1', dueAt: null }), assignments()[1]])
    await sync()
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1', dueAt: null }), canvasAssignment(101, 502, { name: '과제 2', dueAt: null })])
    await ctx.pool.query('UPDATE notifications SET read_at = detected_at')
    await sync()
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1', dueAt: FUTURE_2 }), canvasAssignment(101, 502, { name: '과제 2', dueAt: null })])
    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [
      change('assignment_due_changed', 'assignment:501', { beforeDueAt: FUTURE_1 }),
      change('assignment_due_changed', 'assignment:502', { beforeDueAt: FUTURE_1 }),
      change('assignment_due_changed', 'assignment:501', { afterDueAt: FUTURE_2 }),
    ])
  })

  it('제목 변경 → assignment_title_changed 1건 (사용자가 본 제목 → 새 제목), 본 제목도 갱신', async () => {
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1 (수정)', dueAt: FUTURE_1 }), assignments()[1]])

    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [
      change('assignment_title_changed', 'assignment:501', { beforeTitle: '과제 1', afterTitle: '과제 1 (수정)' }),
    ])
    assert.equal((await seenValues(ctx.pool, a.userId)).assignments[0].title, '과제 1 (수정)')
  })

  it('과목 안에서 그 과제만 사라짐 → assignment_removed 1건 (전: 마감, 후: 없음)', async () => {
    canvas.setAssignments(TOKEN_A, 101, [assignments()[1]])

    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [change('assignment_removed', 'assignment:501', { beforeDueAt: FUTURE_1 })])
  })

  it('새 공지 → announcement_created 1건 (전/후 값 없음)', async () => {
    canvas.setAnnouncements(TOKEN_A, 101, [announcement(), canvasAnnouncement(101, 702, { title: '공지 2', postedAt: posted })])

    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [change('announcement_created', 'announcement:702')])
  })

  it('공지 본문만 수정 → announcement_updated 1건 (제목 전 = 후), 본 해시 갱신', async () => {
    const before = (await seenValues(ctx.pool, a.userId)).announcements[0].hash
    canvas.setAnnouncements(TOKEN_A, 101, [announcement({ message: '<p>바뀐 본문</p>' })])

    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [
      change('announcement_updated', 'announcement:701', { beforeTitle: '공지 1', afterTitle: '공지 1' }),
    ])
    assert.notEqual((await seenValues(ctx.pool, a.userId)).announcements[0].hash, before)
  })

  it('공지 제목 수정 → announcement_updated 1건 (제목 전 · 후)', async () => {
    canvas.setAnnouncements(TOKEN_A, 101, [announcement({ title: '공지 1 (정정)' })])

    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [
      change('announcement_updated', 'announcement:701', { beforeTitle: '공지 1', afterTitle: '공지 1 (정정)' }),
    ])
  })

  it('같은 동기화에서 처음 보이는 공지는 "새 공지"만 (수정 알림 없음)', async () => {
    canvas.setAnnouncements(TOKEN_A, 101, [announcement(), canvasAnnouncement(101, 702, { title: '공지 2', message: '<p>x</p>', postedAt: posted })])
    await sync()
    canvas.setAnnouncements(TOKEN_A, 101, [announcement(), canvasAnnouncement(101, 702, { title: '공지 2', message: '<p>x</p>', postedAt: posted })])
    await sync()

    assert.deepEqual((await changes(ctx.pool, a.userId)).map((c) => c.kind), ['announcement_created'])
  })

  it('제목 + 마감이 한 번에 바뀌면 종류별로 각 1건', async () => {
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1 (수정)', dueAt: FUTURE_2 }), assignments()[1]])

    await sync()

    assert.deepEqual((await changes(ctx.pool, a.userId)).map((c) => c.kind).sort(), ['assignment_due_changed', 'assignment_title_changed'])
  })

  it('알린 뒤 같은 Canvas 상태로 다시 동기화하면 추가 0건 (본 값이 이미 새 값)', async () => {
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1 (수정)', dueAt: FUTURE_2 }), assignments()[1]])
    canvas.setAnnouncements(TOKEN_A, 101, [announcement({ message: '<p>바뀐 본문</p>' })])
    await sync()
    const first = await countNotifications(ctx.pool)

    await sync()
    await sync()

    assert.equal(first, 3)
    assert.equal(await countNotifications(ctx.pool), 3)
  })

  it('정리 규칙 뒤의 값끼리 비교: 255자를 넘는 같은 제목이 계속 와도 제목 변경 없음', async () => {
    const long = '가'.repeat(300)
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: long, dueAt: FUTURE_1 }), assignments()[1]])
    await sync()
    await sync()

    assert.deepEqual(await changes(ctx.pool, a.userId), [
      change('assignment_title_changed', 'assignment:501', { beforeTitle: '과제 1', afterTitle: '가'.repeat(255) }),
    ])
  })
})
