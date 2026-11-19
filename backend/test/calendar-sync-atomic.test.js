import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { signedInUser } from './helpers/lms-context.js'
import { icloudUrl } from './helpers/fake-icloud.js'
import { ics, vevent } from './helpers/ics-builder.js'
import { buildScheduleApp, registerLink, scheduleRows, linkRows, LINK_TOKEN_A, LINK_TOKEN_B } from './helpers/schedule-context.js'

const lesson = (fields = {}) => vevent({ uid: 'lesson', summary: '수업', start: '2026-11-20T01:00:00Z', end: '2026-11-20T02:00:00Z', ...fields })
const club = (fields = {}) => vevent({ uid: 'club', summary: '동아리', start: '2026-11-21T09:00:00Z', end: '2026-11-21T10:00:00Z', ...fields })

// 트랜잭션 연결과 풀 둘 다에서 "일정(schedules) 쓰기"를 세다가 n번째에서 한 번 DB 에러를 던진다.
// 풀까지 감시해야 트랜잭션을 빼먹은 구현(풀로 바로 쓰기)에서도 같은 지점에서 실패시킬 수 있다
function createScheduleWriteFaultPool(pool, fault) {
  const isScheduleWrite = (sql) => /^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+schedules\b/i.test(sql)
  const guard = (run) => async (sql, params) => {
    if (fault.failOn && isScheduleWrite(String(sql))) {
      fault.seen += 1
      if (fault.seen === fault.failOn) {
        fault.failOn = null
        throw Object.assign(new Error('injected schedule write failure'), { code: 'ER_INJECTED_FAILURE' })
      }
    }
    return run(sql, params)
  }
  const wrap = (connection) =>
    new Proxy(connection, {
      get(target, prop) {
        if (prop === 'query' || prop === 'execute') return guard((sql, params) => target[prop](sql, params))
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  return {
    execute: guard((sql, params) => pool.execute(sql, params)),
    query: guard((sql, params) => pool.query(sql, params)),
    getConnection: async () => wrap(await pool.getConnection()),
  }
}

// 연결 하나의 반영은 한 트랜잭션 (ADR 0010, 6단계 리뷰): 중간 쓰기가 실패하면 먼저 쓴 것도 남지 않는다
describe('iCloud 동기화: 반영 중 실패는 그 연결만 통째로 되돌린다', () => {
  let ctx
  let built
  let a

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    built = buildScheduleApp(ctx)
    built.icloud.setCalendar(LINK_TOKEN_A, ics(lesson(), club()))
    a = await signedInUser(built.app, 'a@example.com')
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))
  })
  after(async () => {
    await ctx.close()
  })

  const setCalendar = (...events) => built.icloud.setCalendar(LINK_TOKEN_A, ics(...events))

  it('반영 중 2번째 일정 쓰기(사라짐 표시)에서 DB 오류 → 그 연결의 일정 행 변경 0건(먼저 쓴 upsert도 롤백) · failing, 다른 연결은 그대로 반영', async () => {
    const fault = { failOn: null, seen: 0 }
    const faulty = buildScheduleApp(ctx, { pool: createScheduleWriteFaultPool(ctx.pool, fault), icloud: built.icloud, clock: built.clock })
    built.icloud.setCalendar(LINK_TOKEN_B, ics(vevent({ uid: 'b', summary: '개인', start: '2026-11-25T01:00:00Z', end: '2026-11-25T02:00:00Z' })))
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_B))
    const [linkA, linkB] = await linkRows(ctx.pool, a.userId)
    const rowsOf = async (linkId) => (await scheduleRows(ctx.pool, a.userId)).filter((r) => r.calendar_link_id === linkId)
    const beforeA = await rowsOf(linkA.id)
    // A: 수업은 바뀌고(upsert = 1번째 쓰기) 동아리는 사라짐(deleted_at = 2번째 쓰기), B: 제목만 바뀜
    setCalendar(lesson({ summary: '수업 (바뀜)' }))
    built.icloud.setCalendar(LINK_TOKEN_B, ics(vevent({ uid: 'b', summary: '개인 (바뀜)', start: '2026-11-25T01:00:00Z', end: '2026-11-25T02:00:00Z' })))
    fault.failOn = 2

    await faulty.lms.calendarSync.syncUser(a.userId)

    assert.equal(fault.failOn, null, '전제: 2번째 일정 쓰기에서 실제로 실패했다')
    assert.deepEqual(await rowsOf(linkA.id), beforeA, 'A의 일정 행은 하나도 바뀌지 않음')
    const [afterA, afterB] = await linkRows(ctx.pool, a.userId)
    assert.deepEqual([afterA.sync_status, afterA.last_error_code], ['failing', 'internal_error'])
    assert.deepEqual([afterB.sync_status, (await rowsOf(linkB.id)).map((r) => r.title)], ['ok', ['개인 (바뀜)']])
  })
})
