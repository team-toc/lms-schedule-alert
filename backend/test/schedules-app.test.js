import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { signedInUser } from './helpers/lms-context.js'
import { buildScheduleApp, createAppSchedule, schedulePath, scheduleRows, SCHEDULES_PATH } from './helpers/schedule-context.js'

const START = '2026-11-20T10:00:00+09:00'
const END = '2026-11-20T11:30:00+09:00'

// 앱 자체 일정 CRUD (ADR 0010): 입력 검사, 내 것만, iCloud 등 외부 일정은 읽기 전용
describe('앱 자체 일정 API (/api/calendar/schedules)', () => {
  let ctx
  let built
  let a
  let b

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    built = buildScheduleApp(ctx)
    a = await signedInUser(built.app, 'a@example.com')
    b = await signedInUser(built.app, 'b@example.com')
  })
  after(async () => {
    await ctx.close()
  })

  // 외부(iCloud) 일정 행을 직접 만든다 (연결 포함)
  async function icloudSchedule(userId) {
    const [link] = await ctx.pool.execute("INSERT INTO calendar_links (user_id, provider, url_enc, url_hash, sync_status) VALUES (?, 'icloud', 'v1:x', ?, 'ok')", [userId, 'c'.repeat(64)])
    const [row] = await ctx.pool.execute(
      "INSERT INTO schedules (user_id, calendar_link_id, source, external_id, title, start_at, end_at) VALUES (?, ?, 'icloud', ?, '아이클라우드', ?, ?)",
      [userId, link.insertId, 'd'.repeat(64), new Date('2026-11-21T01:00:00Z'), new Date('2026-11-21T02:00:00Z')],
    )
    return row.insertId
  }

  it('로그인하지 않으면 401', async () => {
    const anonymous = request(built.app)
    await anonymous.post(SCHEDULES_PATH).send({ title: 'x', startAt: START, endAt: END }).expect(401)
    await anonymous.patch(schedulePath(1)).send({ title: 'x' }).expect(401)
    await anonymous.delete(schedulePath(1)).expect(401)
  })

  it('만들기: 201, 시각은 UTC(Z)로, source app, 하루 종일 아님(날짜 칸 null)', async () => {
    const res = await createAppSchedule(a.agent, { title: '  팀 회의  ', startAt: START, endAt: END }).expect(201)

    assert.deepEqual({ ...res.body, id: undefined }, {
      id: undefined, source: 'app', calendarLinkId: null, title: '팀 회의',
      startAt: '2026-11-20T01:00:00.000Z', endAt: '2026-11-20T02:30:00.000Z', isAllDay: false, startDate: null, endDate: null,
    })
    assert.equal(typeof res.body.id, 'number')
    const [row] = await scheduleRows(ctx.pool, a.userId)
    assert.deepEqual([row.source, row.calendar_link_id, row.external_id, row.deleted_at], ['app', null, null, null])
  })

  it('하루 종일: 날짜만(끝 날짜는 마지막 날 다음 날, 미포함) → 서울 자정 ~ 다음 자정(UTC), 날짜 칸도 돌려준다', async () => {
    const res = await createAppSchedule(a.agent, { title: '시험 기간', startAt: '2026-11-20', endAt: '2026-11-23', isAllDay: true }).expect(201)

    assert.deepEqual([res.body.startAt, res.body.endAt, res.body.isAllDay, res.body.startDate, res.body.endDate], [
      '2026-11-19T15:00:00.000Z', '2026-11-22T15:00:00.000Z', true, '2026-11-20', '2026-11-23',
    ])
  })

  it('제목은 1 ~ 255 코드포인트(이모지 255개 OK, 256개 거부), 공백만 · 문자열 아님 · 없음은 거부', async () => {
    await createAppSchedule(a.agent, { title: '😀'.repeat(255), startAt: START, endAt: END }).expect(201)

    const cases = [
      [{ title: '😀'.repeat(256) }, 'title_too_long'],
      [{ title: '' }, 'missing_title'],
      [{ title: '   ' }, 'missing_title'],
      [{ title: undefined }, 'missing_title'],
      [{ title: 123 }, 'invalid_title'],
    ]
    for (const [override, code] of cases) {
      const res = await a.agent.post(SCHEDULES_PATH).send({ title: '일정', startAt: START, endAt: END, ...override }).expect(400)
      assert.deepEqual([res.body.error, res.body.field], [code, 'title'], JSON.stringify(override))
    }
  })

  it('시각: 오프셋 없는 값 · 날짜만 · 없는 날짜 · 없음은 거부, 시작 >= 끝은 invalid_range (길이 0도 앱에서는 거부)', async () => {
    const cases = [
      [{ startAt: '2026-11-20T10:00:00' }, 'invalid_start_at', 'startAt'],
      [{ endAt: '2026-11-20T11:00:00.000' }, 'invalid_end_at', 'endAt'],
      [{ startAt: '2026-11-20' }, 'invalid_start_at', 'startAt'],
      [{ startAt: '2026-02-30T10:00:00Z' }, 'invalid_start_at', 'startAt'],
      [{ startAt: undefined }, 'missing_start_at', 'startAt'],
      [{ endAt: undefined }, 'missing_end_at', 'endAt'],
      [{ startAt: END, endAt: END }, 'invalid_range', 'endAt'],
      [{ startAt: END, endAt: START }, 'invalid_range', 'endAt'],
      [{ isAllDay: 'yes' }, 'invalid_is_all_day', 'isAllDay'],
      [{ isAllDay: true }, 'invalid_start_at', 'startAt'],
      [{ isAllDay: true, startAt: '2026-11-20', endAt: '2026-11-20' }, 'invalid_range', 'endAt'],
      [{ isAllDay: true, startAt: '2026-11-20', endAt: '2026-11-21T00:00:00Z' }, 'invalid_end_at', 'endAt'],
    ]
    for (const [override, code, field] of cases) {
      const res = await a.agent.post(SCHEDULES_PATH).send({ title: '일정', startAt: START, endAt: END, ...override }).expect(400)
      assert.deepEqual([res.body.error, res.body.field], [code, field], JSON.stringify(override))
    }
    assert.equal((await scheduleRows(ctx.pool, a.userId)).length, 0, '실패한 요청은 아무것도 저장하지 않음')
  })

  it('수정: 보낸 칸만 바꾸고 200, 바꾼 결과가 시작 >= 끝이면 400이고 그대로', async () => {
    const { body: created } = await createAppSchedule(a.agent, { title: '회의', startAt: START, endAt: END }).expect(201)

    const renamed = await a.agent.patch(schedulePath(created.id)).send({ title: '회의 (변경)' }).expect(200)
    assert.deepEqual([renamed.body.title, renamed.body.startAt, renamed.body.endAt], ['회의 (변경)', created.startAt, created.endAt])

    const moved = await a.agent.patch(schedulePath(created.id)).send({ endAt: '2026-11-20T13:00:00+09:00' }).expect(200)
    assert.equal(moved.body.endAt, '2026-11-20T04:00:00.000Z')

    const bad = await a.agent.patch(schedulePath(created.id)).send({ startAt: '2026-11-20T14:00:00+09:00' }).expect(400)
    assert.equal(bad.body.error, 'invalid_range')
    const [row] = await scheduleRows(ctx.pool, a.userId)
    assert.equal(row.start_at.toISOString(), '2026-11-20T01:00:00.000Z')
  })

  it('수정은 기존 값과 합친 최종 상태로 검사: a) 시작만 바꿔 끝보다 늦음 · b) 끝만 바꿔 시작보다 빠름 → 400 invalid_range, c) isAllDay만 바꿈(true · false) → 날짜(시각) 두 칸 요구 · 400, 모두 일정은 그대로', async () => {
    const { body: timed } = await createAppSchedule(a.agent, { title: '시각 일정', startAt: START, endAt: END }).expect(201)
    const { body: allDay } = await createAppSchedule(a.agent, { title: '하루 종일', startAt: '2026-11-25', endAt: '2026-11-26', isAllDay: true }).expect(201)
    const cases = [
      [timed.id, { startAt: '2026-11-20T12:00:00+09:00' }, 'invalid_range', 'endAt'],
      [timed.id, { endAt: '2026-11-20T09:00:00+09:00' }, 'invalid_range', 'endAt'],
      [timed.id, { startAt: END }, 'invalid_range', 'endAt'],
      [timed.id, { isAllDay: true }, 'missing_start_at', 'startAt'],
      [timed.id, { isAllDay: true, startAt: '2026-11-20' }, 'missing_end_at', 'endAt'],
      [allDay.id, { endAt: '2026-11-25' }, 'invalid_range', 'endAt'],
      [allDay.id, { isAllDay: false }, 'missing_start_at', 'startAt'],
      [allDay.id, { startAt: '2026-11-25T10:00:00+09:00' }, 'invalid_start_at', 'startAt'],
    ]
    for (const [id, body, code, field] of cases) {
      const res = await a.agent.patch(schedulePath(id)).send(body).expect(400)
      assert.deepEqual([res.body.error, res.body.field], [code, field], JSON.stringify(body))
    }

    const rows = await scheduleRows(ctx.pool, a.userId)
    assert.deepEqual(rows.map((r) => [r.title, r.start_at.toISOString(), r.end_at.toISOString(), Boolean(r.is_all_day)]), [
      ['시각 일정', timed.startAt, timed.endAt, false],
      ['하루 종일', allDay.startAt, allDay.endAt, true],
    ])
  })

  it('수정: 빈 본문은 empty_update, 하루 종일로 바꿀 때는 날짜 두 칸이 모두 필요', async () => {
    const { body: created } = await createAppSchedule(a.agent, { startAt: START, endAt: END }).expect(201)

    assert.equal((await a.agent.patch(schedulePath(created.id)).send({}).expect(400)).body.error, 'empty_update')
    assert.equal((await a.agent.patch(schedulePath(created.id)).send({ isAllDay: true }).expect(400)).body.error, 'missing_start_at')
    const allDay = await a.agent.patch(schedulePath(created.id)).send({ isAllDay: true, startAt: '2026-11-20', endAt: '2026-11-21' }).expect(200)
    assert.deepEqual([allDay.body.isAllDay, allDay.body.startDate, allDay.body.endDate], [true, '2026-11-20', '2026-11-21'])
  })

  it('삭제: 204, 다시 수정 · 삭제하면 404 (행은 deleted_at으로 남음)', async () => {
    const { body: created } = await createAppSchedule(a.agent, { startAt: START, endAt: END }).expect(201)

    await a.agent.delete(schedulePath(created.id)).expect(204)

    assert.equal((await a.agent.patch(schedulePath(created.id)).send({ title: 'x' }).expect(404)).body.error, 'schedule_not_found')
    await a.agent.delete(schedulePath(created.id)).expect(404)
    const [row] = await scheduleRows(ctx.pool, a.userId)
    assert.ok(row.deleted_at instanceof Date)
  })

  it('다른 사용자의 일정 · 없는 id · 형식이 틀린 id는 수정 · 삭제 모두 404 schedule_not_found, 원래 일정은 그대로', async () => {
    const { body: mine } = await createAppSchedule(a.agent, { title: 'A의 일정', startAt: START, endAt: END }).expect(201)

    for (const id of [mine.id, mine.id + 1000, 'abc', '0', '-1', '1.5', '9'.repeat(30)]) {
      assert.equal((await b.agent.patch(schedulePath(id)).send({ title: '가로채기' }).expect(404)).body.error, 'schedule_not_found', String(id))
      await b.agent.delete(schedulePath(id)).expect(404)
    }
    const [row] = await scheduleRows(ctx.pool, a.userId)
    assert.deepEqual([row.title, row.deleted_at], ['A의 일정', null])
  })

  it('iCloud 일정은 주인이 수정 · 삭제해도 403 schedule_read_only(그대로), 다른 사용자가 하면 404', async () => {
    const id = await icloudSchedule(a.userId)

    assert.equal((await a.agent.patch(schedulePath(id)).send({ title: '바꾸기' }).expect(403)).body.error, 'schedule_read_only')
    assert.equal((await a.agent.delete(schedulePath(id)).expect(403)).body.error, 'schedule_read_only')
    await b.agent.patch(schedulePath(id)).send({ title: '바꾸기' }).expect(404)
    await b.agent.delete(schedulePath(id)).expect(404)
    const [row] = await scheduleRows(ctx.pool, a.userId)
    assert.deepEqual([row.title, row.deleted_at], ['아이클라우드', null])
  })
})
