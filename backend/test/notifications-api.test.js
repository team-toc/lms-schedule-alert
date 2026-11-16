import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasAnnouncement, CANVAS_BASE_URL } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, DAY_MS, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'
import {
  insertNotification,
  sharedId,
  encodeCursor,
  NOTIFICATIONS_PATH,
  READ_ALL_PATH,
  readPath,
  FUTURE_1,
  FUTURE_2,
} from './helpers/notification-context.js'

const BODY_MARKER = 'BODY-MARKER-MUST-NOT-APPEAR'

// 알림 목록 · 읽음 API (ADR 0009 API 절). 알림 행은 직접 넣어 감지 로직과 떼어 본다
describe('알림 API: GET /api/notifications · 읽음', () => {
  let ctx
  let built
  let a
  let b
  let ids

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    const canvas = createFakeCanvas()
    built = buildLmsApp(ctx, { canvas })
    const posted = new Date(built.clock.now().getTime() - DAY_MS).toISOString()
    for (const [token, id] of [
      [TOKEN_A, 9001],
      [TOKEN_B, 9002],
    ]) {
      canvas.addAccount(token, { id })
      canvas.setCourses(token, [canvasCourse(101, { name: '자료구조' })])
      canvas.setAssignments(token, 101, [canvasAssignment(101, 501, { name: '과제 1', dueAt: FUTURE_2 })])
      canvas.setAnnouncements(token, 101, [canvasAnnouncement(101, 701, { title: '공지 1', message: `<p>${BODY_MARKER}</p>`, postedAt: posted })])
    }
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
    ids = { assignmentId: await sharedId(ctx.pool, 'assignments', 501), announcementId: await sharedId(ctx.pool, 'announcements', 701) }
  })
  after(async () => {
    await ctx.close()
  })

  const list = (agent, query = {}) => agent.get(NOTIFICATIONS_PATH).query(query)
  // 사용자에게 마감 변경 알림 n개 (감지 시각 1분 간격), 넣은 id 순서대로
  async function seedMany(userId, n, extra = {}) {
    const inserted = []
    for (let i = 0; i < n; i += 1) {
      const detectedAt = new Date(Date.UTC(2026, 10, 13, 0, i)).toISOString()
      inserted.push(await insertNotification(ctx.pool, { userId, assignmentId: ids.assignmentId, values: { beforeDueAt: FUTURE_1, afterDueAt: FUTURE_2 }, detectedAt, ...extra }))
    }
    return inserted
  }

  it('로그인하지 않으면 세 경로 모두 401', async () => {
    const anonymous = request(built.app)
    await anonymous.get(NOTIFICATIONS_PATH).expect(401)
    await anonymous.post(readPath(1)).expect(401)
    await anonymous.post(READ_ALL_PATH).expect(401)
  })

  it('항목 모양: 종류 · 과목 이름 · 제목 · 전/후(마감은 UTC ISO) · 감지 시각 · 읽음 · Canvas 링크', async () => {
    const id = await insertNotification(ctx.pool, {
      userId: a.userId,
      assignmentId: ids.assignmentId,
      values: { beforeDueAt: '2026-11-20T23:59:00+09:00', afterDueAt: FUTURE_2 },
      detectedAt: '2026-11-13T03:00:00.000Z',
    })

    const res = await list(a.agent).expect(200)

    assert.deepEqual(res.body, {
      notifications: [
        {
          id,
          kind: 'assignment_due_changed',
          courseName: '자료구조',
          title: '과제 1',
          before: { dueAt: '2026-11-20T14:59:00.000Z' },
          after: { dueAt: FUTURE_2 },
          detectedAt: '2026-11-13T03:00:00.000Z',
          read: false,
          url: `${CANVAS_BASE_URL}/courses/101/assignments/501`,
        },
      ],
      nextCursor: null,
    })
  })

  it('종류별 전/후: 새 과제 (null → 마감) · 사라짐 (마감 → null) · 제목 변경 · 새 공지 (null · null) · 공지 수정 (제목), 공지 본문은 응답 어디에도 없음', async () => {
    const add = (kind, target, values = {}) => insertNotification(ctx.pool, { userId: a.userId, kind, ...target, values })
    const assignment = { assignmentId: ids.assignmentId }
    const announcement = { announcementId: ids.announcementId }
    await add('assignment_created', assignment, { afterDueAt: FUTURE_2 })
    await add('assignment_removed', assignment, { beforeDueAt: FUTURE_1 })
    await add('assignment_title_changed', assignment, { beforeTitle: '과제 0', afterTitle: '과제 1' })
    await add('announcement_created', announcement)
    await add('announcement_updated', announcement, { beforeTitle: '공지 0', afterTitle: '공지 1' })

    const res = await list(a.agent).expect(200)

    assert.deepEqual(
      res.body.notifications.map((n) => [n.kind, n.before, n.after]).reverse(),
      [
        ['assignment_created', null, { dueAt: FUTURE_2 }],
        ['assignment_removed', { dueAt: FUTURE_1 }, null],
        ['assignment_title_changed', { title: '과제 0' }, { title: '과제 1' }],
        ['announcement_created', null, null],
        ['announcement_updated', { title: '공지 0' }, { title: '공지 1' }],
      ],
    )
    const announcementItem = res.body.notifications[0]
    assert.equal(announcementItem.url, `${CANVAS_BASE_URL}/courses/101/discussion_topics/701`)
    assert.equal(announcementItem.title, '공지 1')
    assert.ok(!res.text.includes(BODY_MARKER), '공지 본문(HTML)은 응답에 없음')
    assert.ok(!('body' in announcementItem) && !('message' in announcementItem))
  })

  it('7. 내 알림만, 최신순(id 내림차순)', async () => {
    const mine = await seedMany(a.userId, 3)
    await seedMany(b.userId, 2)

    const res = await list(a.agent).expect(200)

    assert.deepEqual(res.body.notifications.map((n) => n.id), [...mine].reverse())
  })

  it('7. unread=true는 안 읽은 것만, unread=false · 생략은 전부', async () => {
    const [first, second, third] = await seedMany(a.userId, 3)
    await ctx.pool.query('UPDATE notifications SET read_at = detected_at WHERE id = ?', [second])

    assert.deepEqual((await list(a.agent, { unread: 'true' }).expect(200)).body.notifications.map((n) => n.id), [third, first])
    assert.equal((await list(a.agent, { unread: 'false' }).expect(200)).body.notifications.length, 3)
    assert.equal((await list(a.agent).expect(200)).body.notifications.find((n) => n.id === second).read, true)
  })

  it('7. 커서: limit 2로 5개 → 2 · 2 · 1, 빠짐 · 겹침 없음, 마지막 페이지 nextCursor null', async () => {
    const all = (await seedMany(a.userId, 5)).reverse()
    const pages = []
    let cursor
    do {
      const res = await list(a.agent, { limit: 2, ...(cursor ? { cursor } : {}) }).expect(200)
      pages.push(res.body.notifications.map((n) => n.id))
      cursor = res.body.nextCursor
    } while (cursor)

    assert.deepEqual(pages, [all.slice(0, 2), all.slice(2, 4), all.slice(4)])
  })

  it('7. 커서 경계: 남은 개수가 limit과 같으면 그 페이지에서 nextCursor null (빈 페이지를 만들지 않음)', async () => {
    await seedMany(a.userId, 4)

    const first = (await list(a.agent, { limit: 2 }).expect(200)).body
    const second = (await list(a.agent, { limit: 2, cursor: first.nextCursor }).expect(200)).body

    assert.equal(typeof first.nextCursor, 'string')
    assert.equal(second.notifications.length, 2)
    assert.equal(second.nextCursor, null)
  })

  it('7. 커서: 첫 페이지 뒤에 새 알림이 생겨도 다음 페이지는 이어서 (새 것은 끼지 않음), unread 필터와 함께', async () => {
    const all = (await seedMany(a.userId, 4)).reverse()
    const first = (await list(a.agent, { limit: 2, unread: 'true' }).expect(200)).body
    const newer = await seedMany(a.userId, 1)

    const second = (await list(a.agent, { limit: 2, unread: 'true', cursor: first.nextCursor }).expect(200)).body

    assert.deepEqual(second.notifications.map((n) => n.id), all.slice(2))
    assert.ok(!second.notifications.some((n) => n.id === newer[0]))
  })

  it('7. limit 기본 20 · 최대 50', async () => {
    await seedMany(a.userId, 51)

    assert.equal((await list(a.agent).expect(200)).body.notifications.length, 20)
    const max = (await list(a.agent, { limit: 50 }).expect(200)).body
    assert.equal(max.notifications.length, 50)
    assert.equal(typeof max.nextCursor, 'string')
  })

  it('다른 사용자 목록에서 얻은 커서를 써도 내 알림만 나온다', async () => {
    await seedMany(b.userId, 3)
    const mine = await seedMany(a.userId, 2)
    const bCursor = (await list(b.agent, { limit: 1 }).expect(200)).body.nextCursor

    const res = await list(a.agent, { cursor: bCursor }).expect(200)

    assert.ok(res.body.notifications.every((n) => mine.includes(n.id)))
  })

  it('잘못된 커서는 400 invalid_cursor (base64url 아님 · 양의 정수 아님 · 패딩 · 여러 개 · 아주 큰 수)', async () => {
    const bad = ['!!!', '', 'a b', encodeCursor('0'), encodeCursor('-1'), encodeCursor('1.5'), encodeCursor('abc'), encodeCursor('1e3'), encodeCursor('01'), encodeCursor(' 1'), encodeCursor('9'.repeat(30)), 'MQ==']
    for (const cursor of bad) {
      const res = await list(a.agent, { cursor }).expect(400)
      assert.equal(res.body.error, 'invalid_cursor', JSON.stringify(cursor))
    }
    const twice = await a.agent.get(`${NOTIFICATIONS_PATH}?cursor=${encodeCursor('5')}&cursor=${encodeCursor('6')}`).expect(400)
    assert.equal(twice.body.error, 'invalid_cursor')
  })

  it('잘못된 limit은 400 invalid_limit, 잘못된 unread는 400 invalid_unread', async () => {
    for (const limit of ['0', '51', '-1', '1.5', 'abc', '', '1e1', ' 5']) {
      assert.equal((await list(a.agent, { limit }).expect(400)).body.error, 'invalid_limit', JSON.stringify(limit))
    }
    for (const unread of ['yes', '1', 'TRUE', '']) {
      assert.equal((await list(a.agent, { unread }).expect(400)).body.error, 'invalid_unread', JSON.stringify(unread))
    }
  })

  it('8. 읽음: 내 알림 → 204 · read true, 다시 해도 204 · 읽은 시각 그대로', async () => {
    const [id] = await seedMany(a.userId, 1)

    await a.agent.post(readPath(id)).expect(204)
    const [[first]] = await ctx.pool.query('SELECT read_at FROM notifications WHERE id = ?', [id])
    built.clock.advance(60 * 1000)
    await a.agent.post(readPath(id)).expect(204)
    const [[again]] = await ctx.pool.query('SELECT read_at FROM notifications WHERE id = ?', [id])

    assert.equal((await list(a.agent).expect(200)).body.notifications[0].read, true)
    assert.ok(first.read_at)
    assert.equal(again.read_at.getTime(), first.read_at.getTime())
  })

  it('8. 다른 사용자 알림 · 없는 id · 형식이 틀린 id는 모두 404 notification_not_found, 남의 알림은 그대로 안 읽음', async () => {
    const [others] = await seedMany(b.userId, 1)

    for (const id of [others, others + 1000, 'abc', '0', '-1', '1.5', '9'.repeat(30)]) {
      const res = await a.agent.post(readPath(id)).expect(404)
      assert.equal(res.body.error, 'notification_not_found', String(id))
    }
    assert.equal((await list(b.agent).expect(200)).body.notifications[0].read, false)
  })

  it('8. 전체 읽음: 내 알림만 전부 읽음 → 204, 다른 사용자 알림은 그대로', async () => {
    await seedMany(a.userId, 3)
    await seedMany(b.userId, 2)

    await a.agent.post(READ_ALL_PATH).expect(204)

    assert.deepEqual((await list(a.agent, { unread: 'true' }).expect(200)).body.notifications, [])
    assert.equal((await list(b.agent, { unread: 'true' }).expect(200)).body.notifications.length, 2)
  })
})
