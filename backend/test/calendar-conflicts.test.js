import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { signedInUser } from './helpers/lms-context.js'
import { icloudUrl } from './helpers/fake-icloud.js'
import { ics, vevent } from './helpers/ics-builder.js'
import { buildScheduleApp, registerLink, createAppSchedule, schedulePath, CONFLICTS_PATH, LINK_TOKEN_A } from './helpers/schedule-context.js'

const FROM = '2026-11-01T00:00:00.000Z'
const TO = '2026-12-01T00:00:00.000Z'
const at = (hhmm, day = '20') => `2026-11-${day}T${hhmm}:00.000Z`

// 겹침 판단 (ADR 0010): A.start < B.end && B.start < A.end, 맞닿음 · 하루 종일 · 길이 0 · 취소 · 삭제 제외, 같은 쌍은 하나
describe('GET /api/calendar/conflicts', () => {
  let ctx
  let built
  let a

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    built = buildScheduleApp(ctx)
    a = await signedInUser(built.app, 'a@example.com')
  })
  after(async () => {
    await ctx.close()
  })

  const add = async (title, start, end, extra = {}) => (await createAppSchedule(a.agent, { title, startAt: start, endAt: end, ...extra }).expect(201)).body
  const conflicts = async (agent = a.agent, from = FROM, to = TO) => (await agent.get(CONFLICTS_PATH).query({ from, to }).expect(200)).body.conflicts
  const pairs = (list) => list.map((c) => [c.a.title, c.b.title])

  it('일부 겹침 → 한 쌍, 응답 모양: kind · a · b(source · id · 제목 · 시각) · 겹친 구간. a는 먼저 시작한 쪽', async () => {
    const first = await add('회의', at('10:00'), at('11:00'))
    const second = await add('스터디', at('10:30'), at('11:30'))

    const [conflict, ...rest] = await conflicts()

    assert.deepEqual(rest, [])
    assert.deepEqual(conflict, {
      kind: 'schedule_overlap',
      a: { source: 'app', id: first.id, title: '회의', startAt: at('10:00'), endAt: at('11:00') },
      b: { source: 'app', id: second.id, title: '스터디', startAt: at('10:30'), endAt: at('11:30') },
      overlapStartAt: at('10:30'),
      overlapEndAt: at('11:00'),
    })
  })

  it('맞닿음(앞의 끝 = 뒤의 시작)은 겹침이 아니다', async () => {
    await add('1교시', at('09:00'), at('10:00'))
    await add('2교시', at('10:00'), at('11:00'))

    assert.deepEqual(await conflicts(), [])
  })

  it('포함 관계도 겹침, 셋이 서로 겹치면 세 쌍(중복 · 뒤집힌 쌍 없음), 겹친 구간 시작 → id 순', async () => {
    await add('하루 근무', at('09:00'), at('17:00'))
    await add('점심', at('12:00'), at('13:00'))
    await add('통화', at('12:30'), at('12:45'))

    const list = await conflicts()

    assert.deepEqual(pairs(list), [['하루 근무', '점심'], ['하루 근무', '통화'], ['점심', '통화']])
    assert.equal(new Set(list.map((c) => [c.a.id, c.b.id].sort().join('-'))).size, 3)
    assert.ok(list.every((c) => c.a.id !== c.b.id), '자기 자신과는 겹치지 않음')
  })

  it('iCloud 반복 일정은 겹치는 회차 하나만 쌍이 된다 (앱 일정과 섞여도)', async () => {
    built.icloud.setCalendar(LINK_TOKEN_A, ics(vevent({ uid: 'weekly', summary: '주간 수업', start: at('01:00', '02'), end: at('02:00', '02'), rrule: 'FREQ=WEEKLY;COUNT=4' })))
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))
    await add('면담', at('01:30', '16'), at('02:30', '16'))

    const list = await conflicts()

    assert.deepEqual(list.map((c) => [c.a.source, c.a.startAt, c.b.source, c.b.title]), [['icloud', at('01:00', '16'), 'app', '면담']])
  })

  it('하루 종일 일정 · 길이 0 일정 · 지운 일정 · 취소 상태 일정은 겹침에서 뺀다', async () => {
    await add('회의', at('10:00'), at('11:00'))
    await add('시험 기간', '2026-11-20', '2026-11-21', { isAllDay: true })
    const deleted = await add('지운 일정', at('10:15'), at('10:45'))
    await a.agent.delete(schedulePath(deleted.id)).expect(204)
    const cancelled = await add('취소된 일정', at('10:20'), at('10:40'))
    await ctx.pool.query("UPDATE schedules SET status = 'cancelled' WHERE id = ?", [cancelled.id])
    built.icloud.setCalendar(LINK_TOKEN_A, ics(vevent({ uid: 'zero', summary: '알림만', start: at('10:30'), end: at('10:30') })))
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))

    assert.deepEqual(await conflicts(), [])
  })

  it('다른 사용자의 일정과는 겹치지 않는다', async () => {
    const b = await signedInUser(built.app, 'b@example.com')
    await add('내 회의', at('10:00'), at('11:00'))
    await createAppSchedule(b.agent, { title: 'B의 회의', startAt: at('10:00'), endAt: at('11:00') }).expect(201)

    assert.deepEqual(await conflicts(), [])
    assert.deepEqual(await conflicts(b.agent), [])
  })

  it('조회 기간 밖의 일정끼리는 나오지 않는다 (기간과 겹치는 일정만 본다)', async () => {
    await add('10월 회의', '2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z')
    await add('10월 스터디', '2026-10-20T10:30:00Z', '2026-10-20T11:30:00Z')

    assert.deepEqual(await conflicts(), [])
    assert.equal((await conflicts(a.agent, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')).length, 1)
  })

  it('결과 상한: 서로 겹치는 일정 33개(528쌍) → 앞에서부터 500쌍 + truncated: true, 순서는 a 시작 → a id → b 시작 → b id. 상한 안이면 truncated: false', async () => {
    const rows = Array.from({ length: 33 }, (_, i) => [a.userId, 'app', `일정 ${i}`, new Date(Date.UTC(2026, 10, 20, 0, i)), new Date(Date.UTC(2026, 10, 20, 12, 0))])
    await ctx.pool.query('INSERT INTO schedules (user_id, source, title, start_at, end_at) VALUES ?', [rows])

    const body = (await a.agent.get(CONFLICTS_PATH).query({ from: FROM, to: TO }).expect(200)).body

    assert.equal(body.conflicts.length, 500)
    assert.equal(body.truncated, true)
    const key = (c) => [c.a.startAt, String(c.a.id).padStart(12, '0'), c.b.startAt, String(c.b.id).padStart(12, '0')].join('|')
    const keys = body.conflicts.map(key)
    assert.deepEqual(keys, [...keys].sort(), '정렬: a 시작 → a id → b 시작 → b id')
    assert.deepEqual([body.conflicts[0].a.title, body.conflicts[0].b.title], ['일정 0', '일정 1'])
    assert.equal(new Set(body.conflicts.map((c) => `${c.a.id}-${c.b.id}`)).size, 500, '중복 쌍 없음')

    await ctx.pool.query('DELETE FROM schedules WHERE user_id = ? AND title <> ?', [a.userId, '일정 0'])
    await add('겹치는 하나', '2026-11-20T01:00:00Z', '2026-11-20T02:00:00Z')
    const small = (await a.agent.get(CONFLICTS_PATH).query({ from: FROM, to: TO }).expect(200)).body
    assert.deepEqual([small.conflicts.length, small.truncated], [1, false])
  })

  it('기간 검사는 캘린더와 같다: 없음 · 시간대 없음 · to <= from · 92일 초과는 400, 로그인 안 하면 401', async () => {
    const cases = [
      [{ to: TO }, 'missing_from'],
      [{ from: FROM }, 'missing_to'],
      [{ from: '2026-11-01T00:00:00', to: TO }, 'invalid_from'],
      [{ from: TO, to: FROM }, 'invalid_range'],
      [{ from: FROM, to: '2027-02-05T00:00:00Z' }, 'range_too_long'],
    ]
    for (const [query, code] of cases) {
      assert.equal((await a.agent.get(CONFLICTS_PATH).query(query).expect(400)).body.error, code, JSON.stringify(query))
    }
    await request(built.app).get(CONFLICTS_PATH).query({ from: FROM, to: TO }).expect(401)
  })
})
