import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { canvasCourse, canvasAssignment, CANVAS_BASE_URL } from './helpers/fake-canvas.js'
import { connectUser, signedInUser, TOKEN_A } from './helpers/lms-context.js'
import { icloudUrl } from './helpers/fake-icloud.js'
import { ics, vevent } from './helpers/ics-builder.js'
import { buildScheduleApp, registerLink, createAppSchedule, schedulePath, linkRows, EVENTS_PATH, LINK_TOKEN_A, LINK_TOKEN_B } from './helpers/schedule-context.js'

const FROM = '2026-11-20T00:00:00.000Z'
const TO = '2026-11-21T00:00:00.000Z'

// 통합 조회 (ADR 0010): 과제 마감 + 앱 일정 + iCloud 일정, source로 구분, 시각 순. 과제 항목 모양은 그대로
describe('GET /api/calendar/events: 과제 + 앱 + iCloud', () => {
  let ctx
  let built
  let a

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    built = buildScheduleApp(ctx)
    built.canvas.addAccount(TOKEN_A, { id: 9001 })
    built.canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '자료구조' })])
    built.canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: '과제 1', dueAt: '2026-11-20T14:59:00Z' })])
    built.icloud.setCalendar(LINK_TOKEN_A, ics(
      vevent({ uid: 'lesson', summary: '수업', start: '2026-11-20T01:00:00Z', end: '2026-11-20T02:00:00Z' }),
      vevent({ uid: 'holiday', summary: '휴일', start: '2026-11-20', end: '2026-11-21' }),
    ))
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))
  })
  after(async () => {
    await ctx.close()
  })

  const list = (agent, from = FROM, to = TO) => agent.get(EVENTS_PATH).query({ from, to })

  it('한 목록에 source assignment · app · icloud, 시각(마감 · 시작) 순. 과제 항목 모양은 기존 그대로', async () => {
    const { body: app } = await createAppSchedule(a.agent, { title: '스터디', startAt: '2026-11-20T05:00:00Z', endAt: '2026-11-20T06:00:00Z' }).expect(201)
    const [link] = await linkRows(ctx.pool, a.userId)

    const { events } = (await list(a.agent).expect(200)).body

    assert.deepEqual(events.map((e) => [e.source, e.title]), [
      ['icloud', '휴일'],
      ['icloud', '수업'],
      ['app', '스터디'],
      ['assignment', '과제 1'],
    ])
    const assignment = events.find((e) => e.source === 'assignment')
    assert.deepEqual(Object.keys(assignment).sort(), ['courseName', 'dueAt', 'id', 'source', 'title', 'url'])
    assert.deepEqual([assignment.courseName, assignment.dueAt, assignment.url], ['자료구조', '2026-11-20T14:59:00.000Z', `${CANVAS_BASE_URL}/courses/101/assignments/501`])
    assert.deepEqual(events.find((e) => e.source === 'app'), app, '앱 일정 항목 = 만들기 응답과 같은 모양')
    const lesson = events.find((e) => e.title === '수업')
    assert.deepEqual({ ...lesson, id: undefined }, {
      source: 'icloud', id: undefined, calendarLinkId: link.id, title: '수업',
      startAt: '2026-11-20T01:00:00.000Z', endAt: '2026-11-20T02:00:00.000Z', isAllDay: false, startDate: null, endDate: null,
    })
    const holiday = events.find((e) => e.title === '휴일')
    assert.deepEqual([holiday.isAllDay, holiday.startDate, holiday.endDate, holiday.startAt], [true, '2026-11-20', '2026-11-21', '2026-11-19T15:00:00.000Z'])
  })

  it('기간 경계: 구간 일정은 start < to 이고 end > from일 때만(끝이 from에 맞닿으면 빠짐, to에 시작하면 빠짐), 길이 0은 from ≤ 시각 < to', async () => {
    for (const [title, startAt, endAt] of [
      ['앞에 맞닿음', '2026-11-19T23:00:00Z', FROM],
      ['앞에 걸침', '2026-11-19T23:00:00Z', '2026-11-20T00:30:00Z'],
      ['뒤에 시작', TO, '2026-11-21T01:00:00Z'],
      ['뒤에 걸침', '2026-11-20T23:30:00Z', '2026-11-21T01:00:00Z'],
    ]) {
      await createAppSchedule(a.agent, { title, startAt, endAt }).expect(201)
    }
    built.icloud.setCalendar(LINK_TOKEN_A, ics(
      vevent({ uid: 'z-from', summary: '0 at from', start: FROM, end: FROM }),
      vevent({ uid: 'z-to', summary: '0 at to', start: TO, end: TO }),
    ))
    await built.lms.calendarSync.syncUser(a.userId)

    const titles = (await list(a.agent).expect(200)).body.events.filter((e) => e.source !== 'assignment').map((e) => e.title)

    assert.deepEqual(titles.sort(), ['0 at from', '뒤에 걸침', '앞에 걸침'].sort())
  })

  it('지운 앱 일정 · 원본에서 사라진 iCloud 일정 · 취소 상태 일정은 나오지 않는다', async () => {
    const { body: app } = await createAppSchedule(a.agent, { title: '지울 일정', startAt: '2026-11-20T05:00:00Z', endAt: '2026-11-20T06:00:00Z' }).expect(201)
    await a.agent.delete(schedulePath(app.id)).expect(204)
    built.icloud.setCalendar(LINK_TOKEN_A, ics(vevent({ uid: 'holiday', summary: '휴일', start: '2026-11-20', end: '2026-11-21' })))
    await built.lms.calendarSync.syncUser(a.userId)
    await ctx.pool.query("UPDATE schedules SET status = 'cancelled' WHERE title = '휴일'")

    assert.deepEqual((await list(a.agent).expect(200)).body.events.map((e) => e.source), ['assignment'])
  })

  it('다른 사용자의 과제 · 앱 일정 · iCloud 일정은 보이지 않는다', async () => {
    const b = await signedInUser(built.app, 'b@example.com')
    built.icloud.setCalendar(LINK_TOKEN_B, ics(vevent({ uid: 'b', summary: 'B의 일정', start: '2026-11-20T03:00:00Z', end: '2026-11-20T04:00:00Z' })))
    await registerLink(built, b.agent, icloudUrl(LINK_TOKEN_B))
    await createAppSchedule(b.agent, { title: 'B의 앱 일정', startAt: '2026-11-20T05:00:00Z', endAt: '2026-11-20T06:00:00Z' }).expect(201)

    const mine = (await list(a.agent).expect(200)).body.events.map((e) => e.title)
    const theirs = (await list(b.agent).expect(200)).body.events.map((e) => e.title)

    assert.ok(!mine.includes('B의 일정') && !mine.includes('B의 앱 일정'))
    assert.deepEqual(theirs.sort(), ['B의 앱 일정', 'B의 일정'].sort())
  })

  it('연결을 지우면 그 일정은 바로 목록에서 빠진다', async () => {
    const [link] = await linkRows(ctx.pool, a.userId)

    await a.agent.delete(`/api/calendar/links/${link.id}`).expect(204)

    assert.deepEqual((await list(a.agent).expect(200)).body.events.map((e) => e.source), ['assignment'])
  })
})
