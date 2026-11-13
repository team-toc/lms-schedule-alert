import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, CALENDAR_PATH, TOKEN_PATH, TOKEN_A } from './helpers/lms-context.js'

const FROM = '2026-11-01T00:00:00.000Z'
const TO = '2026-12-01T00:00:00.000Z'
const SAME_DUE = '2026-11-20T14:59:00Z'
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describe('캘린더: 응답 범위 · 정렬 · 시간대', () => {
  let ctx
  let canvas
  let built
  let a

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    canvas = createFakeCanvas({ pageSize: 10 })
    built = buildLmsApp(ctx, { canvas })
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '자료구조' })])
    // 마감이 같은 과제 셋: Canvas 순서를 일부러 뒤섞는다 → 응답은 id 순
    canvas.setAssignments(TOKEN_A, 101, [
      canvasAssignment(101, 503, { name: '셋', dueAt: SAME_DUE }),
      canvasAssignment(101, 501, { name: '하나', dueAt: SAME_DUE }),
      canvasAssignment(101, 502, { name: '둘', dueAt: SAME_DUE }),
      canvasAssignment(101, 504, { name: '먼저', dueAt: '2026-11-10T00:00:00Z' }),
    ])
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
  })
  after(async () => {
    await ctx.close()
  })

  const list = (params = { from: FROM, to: TO }) => a.agent.get(CALENDAR_PATH).query(params)

  it('정렬: 마감 시각 → id 순서로 항상 같은 결과 (여러 번 불러도 같음)', async () => {
    const first = (await list().expect(200)).body.events
    const second = (await list().expect(200)).body.events

    assert.equal(first[0].title, '먼저', '마감이 이른 것이 먼저')
    // id는 우리 DB의 assignments.id (Canvas id 아님). 같은 마감이면 그 id 오름차순
    const sameDue = first.slice(1)
    assert.deepEqual(sameDue.map((e) => e.title).sort(), ['둘', '셋', '하나'])
    assert.ok(sameDue[0].id < sameDue[1].id && sameDue[1].id < sameDue[2].id, '같은 마감이면 id 오름차순')
    assert.deepEqual(second, first)
  })

  it('응답 시각(from · to · dueAt)은 모두 Z로 끝나는 UTC ISO 8601', async () => {
    const res = await list({ from: '2026-10-31T19:00:00-05:00', to: '2026-12-01T09:00:00+09:00' }).expect(200)

    assert.equal(res.body.from, FROM, '-05:00 → UTC')
    assert.equal(res.body.to, TO, '+09:00 → UTC')
    for (const value of [res.body.from, res.body.to, ...res.body.events.map((e) => e.dueAt)]) {
      assert.match(value, UTC_ISO)
    }
  })

  it('시간대가 없는 값은 from · to 모두 거부한다 (UTC로 간주하지 않음), 범위를 벗어난 오프셋도 거부', async () => {
    const cases = [
      [{ from: '2026-11-01T00:00:00', to: TO }, 'invalid_from', 'from'],
      [{ from: FROM, to: '2026-12-01T00:00:00' }, 'invalid_to', 'to'],
      [{ from: '2026-11-01T00:00:00.000', to: TO }, 'invalid_from', 'from'],
      [{ from: '2026-11-01T00:00:00+24:00', to: TO }, 'invalid_from', 'from'],
      [{ from: '2026-11-01T24:00:00Z', to: TO }, 'invalid_from', 'from'],
    ]
    for (const [params, code, field] of cases) {
      const res = await list(params).expect(400)
      assert.deepEqual({ error: res.body.error, field: res.body.field }, { error: code, field }, JSON.stringify(params))
    }
  })

  it('연결이 끊긴 과제(Canvas 목록에서 사라짐)는 나오지 않는다', async () => {
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 504, { name: '먼저', dueAt: '2026-11-10T00:00:00Z' })])

    await built.lms.lmsSync.syncUser(a.userId)

    assert.deepEqual((await list().expect(200)).body.events.map((e) => e.title), ['먼저'])
  })

  it('연동을 해제한 사용자는 빈 목록 (공유 과제 행은 남아 있어도)', async () => {
    await a.agent.delete(TOKEN_PATH).expect(204)

    assert.deepEqual((await list().expect(200)).body.events, [])
    assert.equal(await ctx.countRows('assignments'), 4)
  })

  it('연결 표에 행이 남아 있어도 연동(lms_tokens)이 없으면 보이지 않는다 (조회가 연동 상태를 함께 확인)', async () => {
    await ctx.pool.query('DELETE FROM lms_tokens WHERE user_id = ?', [a.userId])

    assert.deepEqual((await list().expect(200)).body.events, [])
  })
})
