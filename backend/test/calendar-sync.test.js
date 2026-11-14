import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { signedInUser, holdRequests, DAY_MS } from './helpers/lms-context.js'
import { icloudUrl, icloudFailures } from './helpers/fake-icloud.js'
import { ics, vevent } from './helpers/ics-builder.js'
import { buildScheduleApp, registerLink, scheduleRows, liveSchedules, linkRows, LINK_TOKEN_A, LINK_TOKEN_B } from './helpers/schedule-context.js'

const lesson = (fields = {}) => vevent({ uid: 'lesson', summary: '수업', start: '2026-11-20T01:00:00Z', end: '2026-11-20T02:00:00Z', ...fields })
const club = (fields = {}) => vevent({ uid: 'club', summary: '동아리', start: '2026-11-21T09:00:00Z', end: '2026-11-21T10:00:00Z', ...fields })

// 진짜 풀을 감싸, fault.match(sql)가 참인 트랜잭션 쿼리에서 한 번 예상 밖 DB 에러를 던진다
function createFaultyPool(pool, fault) {
  const guard = (target, method) => async (sql, params) => {
    if (fault.match?.(String(sql))) {
      fault.match = null
      throw Object.assign(new Error('injected failure'), { code: 'ER_INJECTED_FAILURE' })
    }
    return target[method](sql, params)
  }
  const wrap = (connection) =>
    new Proxy(connection, {
      get(target, prop) {
        if (prop === 'query' || prop === 'execute') return guard(target, prop)
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  return { execute: (...args) => pool.execute(...args), query: (...args) => pool.query(...args), getConnection: async () => wrap(await pool.getConnection()) }
}

// iCloud 동기화 (ADR 0010): 전부 받아 파싱까지 성공했을 때만 연결 하나를 한 트랜잭션으로, 멱등, 사라짐 = deleted_at
describe('iCloud 동기화', () => {
  let ctx
  let built
  let fault
  let lines
  let a

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    fault = {}
    lines = []
    built = buildScheduleApp(ctx, { pool: createFaultyPool(ctx.pool, fault), logger: pino({ level: 'trace' }, { write: (line) => lines.push(line) }) })
    built.icloud.setCalendar(LINK_TOKEN_A, ics(lesson(), club()))
    a = await signedInUser(built.app, 'a@example.com')
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))
  })
  after(async () => {
    await ctx.close()
  })

  const sync = () => built.lms.calendarSync.syncUser(a.userId)
  const setCalendar = (...events) => built.icloud.setCalendar(LINK_TOKEN_A, ics(...events))

  it('첫 동기화(등록 직후 백그라운드): 일정이 source icloud · 연결 id와 함께 들어오고 연결은 ok', async () => {
    const rows = await scheduleRows(ctx.pool, a.userId)
    const [link] = await linkRows(ctx.pool, a.userId)

    assert.deepEqual(rows.map((r) => [r.source, r.calendar_link_id, r.title, r.start_at.toISOString()]), [
      ['icloud', link.id, '수업', '2026-11-20T01:00:00.000Z'],
      ['icloud', link.id, '동아리', '2026-11-21T09:00:00.000Z'],
    ])
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.external_id) && /^[0-9a-f]{64}$/.test(r.content_hash)))
    assert.deepEqual([link.sync_status, link.last_error_code], ['ok', null])
    assert.ok(link.last_synced_at instanceof Date)
  })

  it('같은 데이터로 다시 동기화하면 행 · updated_at까지 그대로 (멱등), last_synced_at만 앞으로', async () => {
    const before = await scheduleRows(ctx.pool, a.userId)
    built.clock.advance(60 * 1000)

    assert.equal((await sync()).outcome, 'applied')
    await sync()

    assert.deepEqual(await scheduleRows(ctx.pool, a.userId), before)
    assert.equal((await linkRows(ctx.pool, a.userId))[0].last_synced_at.toISOString(), built.clock.now().toISOString())
  })

  it('바뀐 일정은 같은 행(id)을 고치고, 원본에서 사라진 일정은 deleted_at, 다시 나타나면 deleted_at을 비운다', async () => {
    const [lessonRow, clubRow] = await scheduleRows(ctx.pool, a.userId)
    setCalendar(lesson({ summary: '수업 (보강)', end: '2026-11-20T03:00:00Z' }))

    await sync()
    let rows = await scheduleRows(ctx.pool, a.userId)
    assert.deepEqual([rows[0].id, rows[0].title, rows[0].end_at.toISOString()], [lessonRow.id, '수업 (보강)', '2026-11-20T03:00:00.000Z'])
    assert.notEqual(rows[0].content_hash, lessonRow.content_hash)
    assert.ok(rows[1].deleted_at instanceof Date, '동아리는 사라짐')

    setCalendar(lesson({ summary: '수업 (보강)', end: '2026-11-20T03:00:00Z' }), club())
    await sync()
    rows = await scheduleRows(ctx.pool, a.userId)
    assert.deepEqual([rows.length, rows[1].id, rows[1].deleted_at], [2, clubRow.id, null])
  })

  it('반복 일정의 한 회차만 바뀌면(RECURRENCE-ID) 그 회차 행만 바뀐다', async () => {
    const weekly = { uid: 'weekly', summary: '세미나', start: '2026-11-02T01:00:00Z', end: '2026-11-02T02:00:00Z', rrule: 'FREQ=WEEKLY;COUNT=3' }
    setCalendar(vevent(weekly))
    await sync()
    const before = await liveSchedules(ctx.pool, a.userId)

    setCalendar(vevent(weekly), vevent({ ...weekly, rrule: undefined, summary: '세미나 (변경)', start: '2026-11-10T05:00:00Z', end: '2026-11-10T06:00:00Z', recurrenceId: '2026-11-09T01:00:00Z' }))
    await sync()
    const after = await liveSchedules(ctx.pool, a.userId)

    assert.deepEqual(after.map((s) => [s.title, s.startAt]), [
      ['세미나', '2026-11-02T01:00:00.000Z'],
      ['세미나 (변경)', '2026-11-10T05:00:00.000Z'],
      ['세미나', '2026-11-16T01:00:00.000Z'],
    ])
    assert.deepEqual(new Set(after.map((s) => s.id)), new Set(before.map((s) => s.id)), '행은 그대로(회차 키 같음)')
  })

  it('시간이 지나 창(−30일) 밖으로 나간 회차는 deleted_at', async () => {
    built.clock.advance(60 * DAY_MS)

    await sync()

    assert.deepEqual(await liveSchedules(ctx.pool, a.userId), [])
  })

  it('길이 0 일정이 있어도 동기화 성공 (저장됨), 끝 < 시작 일정만 빠지고 나머지는 반영 · 건너뛴 개수만 로그', async () => {
    setCalendar(
      lesson(),
      vevent({ uid: 'zero', summary: '길이 0', start: '2026-11-22T01:00:00Z', end: '2026-11-22T01:00:00Z' }),
      vevent({ uid: 'backwards', summary: '거꾸로', start: '2026-11-23T05:00:00Z', end: '2026-11-23T04:00:00Z' }),
    )

    assert.equal((await sync()).outcome, 'applied')

    assert.deepEqual((await liveSchedules(ctx.pool, a.userId)).map((s) => [s.title, s.startAt, s.endAt]), [
      ['수업', '2026-11-20T01:00:00.000Z', '2026-11-20T02:00:00.000Z'],
      ['길이 0', '2026-11-22T01:00:00.000Z', '2026-11-22T01:00:00.000Z'],
    ])
    assert.equal((await linkRows(ctx.pool, a.userId))[0].sync_status, 'ok')
    const applied = lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'calendar_sync_applied').at(-1)
    assert.equal(applied.skipped, 1)
    assert.ok(!lines.join('\n').includes('거꾸로'), '로그에 제목 없음')
  })

  it('받기 실패(5xx) → 그 연결 반영 0(행 그대로), failing · icloud_unavailable, 회복 뒤 반영', async () => {
    const before = await scheduleRows(ctx.pool, a.userId)
    setCalendar(lesson({ summary: '바뀜' }))
    built.icloud.intercept(() => true, icloudFailures.serverError, { times: 1 })

    await sync()
    assert.deepEqual(await scheduleRows(ctx.pool, a.userId), before)
    const [link] = await linkRows(ctx.pool, a.userId)
    assert.deepEqual([link.sync_status, link.last_error_code], ['failing', 'icloud_unavailable'])

    await sync()
    assert.deepEqual((await liveSchedules(ctx.pool, a.userId)).map((s) => s.title), ['바뀜'])
  })

  it('파싱 실패 · 일정 수 상한(펼친 뒤 5000개) 초과 → 반영 0, failing과 코드', async () => {
    const before = await scheduleRows(ctx.pool, a.userId)
    built.icloud.setCalendar(LINK_TOKEN_A, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')
    await sync()
    assert.equal((await linkRows(ctx.pool, a.userId))[0].last_error_code, 'icloud_parse_failed')

    const daily = Array.from({ length: 25 }, (_, i) => vevent({ uid: `d${i}`, summary: `매일 ${i}`, start: '2026-10-14T00:00:00Z', end: '2026-10-14T00:10:00Z', rrule: 'FREQ=DAILY' }))
    setCalendar(...daily)
    await sync()

    assert.equal((await linkRows(ctx.pool, a.userId))[0].last_error_code, 'icloud_too_many_events')
    assert.deepEqual(await scheduleRows(ctx.pool, a.userId), before)
  })

  it('형식이 아닌 응답은 "일정 0개"가 아니다: 빈 본문 · HTML(text/calendar로 와도 · text/html) · VCALENDAR 시작/끝 없음 → 파싱 실패 · 기존 일정 그대로', async () => {
    const before = await scheduleRows(ctx.pool, a.userId)
    const calendarType = { 'Content-Type': 'text/calendar; charset=UTF-8' }
    const cases = [
      [() => new Response('', { headers: calendarType }), 'icloud_parse_failed'],
      [() => new Response(null, { headers: calendarType }), 'icloud_parse_failed'],
      [() => new Response('<html><body>maintenance</body></html>', { headers: calendarType }), 'icloud_parse_failed'],
      [icloudFailures.html, 'icloud_not_calendar'],
      [() => new Response('VERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n', { headers: calendarType }), 'icloud_parse_failed'],
      [() => new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n', { headers: calendarType }), 'icloud_parse_failed'],
      [() => new Response('VERSION:2.0\r\nEND:VCALENDAR\r\n', { headers: calendarType }), 'icloud_parse_failed'],
    ]
    for (const [respond, code] of cases) {
      built.icloud.intercept(() => true, respond, { times: 1 })
      await sync()
      const [link] = await linkRows(ctx.pool, a.userId)
      assert.deepEqual([link.sync_status, link.last_error_code], ['failing', code], code)
      assert.deepEqual(await scheduleRows(ctx.pool, a.userId), before, '기존 iCloud 일정은 그대로')
    }
  })

  it('형식이 맞고 일정이 0개인 정상 캘린더는 정상 반영: 기존 일정은 모두 사라짐(deleted_at), 연결은 ok', async () => {
    setCalendar()

    assert.equal((await sync()).outcome, 'applied')

    assert.deepEqual(await liveSchedules(ctx.pool, a.userId), [])
    assert.ok((await scheduleRows(ctx.pool, a.userId)).every((r) => r.deleted_at instanceof Date))
    assert.equal((await linkRows(ctx.pool, a.userId))[0].sync_status, 'ok')
  })

  it('반영 도중 DB 에러 → 그 연결 반영 0(롤백), 실패 기록, 다음 동기화에서 반영', async () => {
    const before = await scheduleRows(ctx.pool, a.userId)
    setCalendar(lesson({ summary: '바뀜' }))
    // 반영 트랜잭션의 마지막(연결 상태 갱신)에서 한 번 실패 → 그 전에 넣은 일정도 롤백돼야 함
    fault.match = (sql) => /^\s*UPDATE calendar_links/i.test(sql)

    await sync()
    assert.deepEqual(await scheduleRows(ctx.pool, a.userId), before)

    await sync()
    assert.deepEqual((await liveSchedules(ctx.pool, a.userId)).map((s) => s.title), ['바뀜'])
  })

  it('연결이 둘이면 하나가 실패해도 다른 하나는 반영된다 (연결마다 따로)', async () => {
    built.icloud.setCalendar(LINK_TOKEN_B, ics(vevent({ uid: 'b', summary: '개인', start: '2026-11-25T01:00:00Z', end: '2026-11-25T02:00:00Z' })))
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_B))
    setCalendar(lesson({ summary: '바뀜' }))
    built.icloud.setCalendar(LINK_TOKEN_B, ics(vevent({ uid: 'b', summary: '개인 (바뀜)', start: '2026-11-25T01:00:00Z', end: '2026-11-25T02:00:00Z' })))
    built.icloud.intercept((req) => req.path.endsWith(LINK_TOKEN_A), icloudFailures.serverError, { times: 1 })

    await sync()

    assert.deepEqual((await liveSchedules(ctx.pool, a.userId)).map((s) => s.title).sort(), ['개인 (바뀜)', '동아리', '수업'])
  })

  it('같은 사용자 동기화를 동시에 두 번 → 하나만 실행(already_running), 행 중복 없음', async () => {
    setCalendar(lesson(), club(), vevent({ uid: 'new', summary: '새 일정', start: '2026-11-26T01:00:00Z', end: '2026-11-26T02:00:00Z' }))
    const hold = holdRequests(built.icloud, () => true)
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
    assert.equal(results.find((r) => r.outcome === 'skipped').reason, 'already_running')
    assert.equal((await scheduleRows(ctx.pool, a.userId)).length, 3)
  })

  it('무효(invalid) 연결은 주기 실행에서 요청하지 않는다', async () => {
    built.icloud.removeCalendar(LINK_TOKEN_A)
    await sync()
    const requested = built.icloud.requests.length

    await built.lms.calendarSyncRunner.runOnce()

    assert.equal(built.icloud.requests.length, requested)
    assert.equal((await linkRows(ctx.pool, a.userId))[0].sync_status, 'invalid')
  })
})
