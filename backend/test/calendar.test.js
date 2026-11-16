import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, CANVAS_BASE_URL } from './helpers/fake-canvas.js'
import { buildLmsApp, signedInUser, connectUser, CALENDAR_PATH, DAY_MS, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'

const FROM = '2026-11-01T00:00:00.000Z'
const TO = '2026-12-01T00:00:00.000Z'

function events(agent, params) {
  return agent.get(CALENDAR_PATH).query(params)
}

describe('GET /api/calendar/events (과제 마감 캘린더)', () => {
  let ctx
  let canvas
  let built
  let a

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    canvas = createFakeCanvas()
    built = buildLmsApp(ctx, { canvas })
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '자료구조' })])
    canvas.setAssignments(TOKEN_A, 101, [
      canvasAssignment(101, 501, { name: '시작 경계', dueAt: FROM }),
      canvasAssignment(101, 502, { name: '끝 직전', dueAt: '2026-11-30T23:59:59.999Z' }),
      canvasAssignment(101, 503, { name: '끝 경계', dueAt: TO }),
      canvasAssignment(101, 504, { name: '마감 없음', dueAt: null }),
      canvasAssignment(101, 505, { name: '시작 직전', dueAt: '2026-10-31T23:59:59.999Z' }),
      canvasAssignment(101, 506, { name: '삭제됨', dueAt: '2026-11-15T00:00:00Z' }),
      canvasAssignment(101, 507, { name: '링크 없음', dueAt: '2026-11-10T00:00:00Z', htmlUrl: 'https://evil.test/x' }),
    ])
    canvas.addAccount(TOKEN_B, { id: 9002 })
    canvas.setCourses(TOKEN_B, [canvasCourse(101, { name: '자료구조' })])
    canvas.setAssignments(TOKEN_B, 101, [canvasAssignment(101, 601, { name: 'B만', dueAt: '2026-11-12T00:00:00Z' })])
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
    await ctx.pool.query('UPDATE assignments SET deleted_at = ? WHERE canvas_id = 506', [new Date(FROM)])
  })
  after(async () => {
    await ctx.close()
  })

  it('11. 기간 [from, to): 시작 경계 포함 · 끝 경계 제외, 다른 사람 과제 · 마감 없는 과제 · 삭제된 과제는 없다, 마감 오름차순', async () => {
    const res = await events(a.agent, { from: FROM, to: TO }).expect(200)

    assert.equal(res.body.from, FROM)
    assert.equal(res.body.to, TO)
    assert.deepEqual(res.body.events.map((e) => e.title), ['시작 경계', '링크 없음', '끝 직전'])
  })

  it('11. 항목 모양: source assignment · id · 과목 이름 · 제목 · 마감(UTC ISO) · Canvas 링크(규칙에 어긋나면 null)', async () => {
    const res = await events(a.agent, { from: FROM, to: TO }).expect(200)
    const [first, noLink] = res.body.events

    assert.deepEqual(Object.keys(first).sort(), ['courseName', 'dueAt', 'id', 'source', 'title', 'url'])
    assert.equal(typeof first.id, 'number')
    assert.deepEqual(
      { ...first, id: undefined },
      { source: 'assignment', id: undefined, courseName: '자료구조', title: '시작 경계', dueAt: FROM, url: `${CANVAS_BASE_URL}/courses/101/assignments/501` },
    )
    assert.equal(noLink.url, null)
  })

  it('오프셋이 있는 시각은 UTC로 바꿔 같은 결과 (+09:00)', async () => {
    const res = await events(a.agent, { from: '2026-11-01T09:00:00+09:00', to: '2026-12-01T09:00:00+09:00' }).expect(200)

    assert.equal(res.body.from, FROM)
    assert.equal(res.body.to, TO)
    assert.equal(res.body.events.length, 3)
  })

  it('Canvas를 연결하지 않은 사용자는 빈 목록 (200)', async () => {
    const { agent } = await signedInUser(built.app, 'c@example.com')

    const res = await events(agent, { from: FROM, to: TO }).expect(200)

    assert.deepEqual(res.body.events, [])
  })

  it('최대 기간 92일은 허용', async () => {
    const to = new Date(new Date(FROM).getTime() + 92 * DAY_MS).toISOString()

    await events(a.agent, { from: FROM, to }).expect(200)
  })

  const invalid = [
    ['from 없음', { to: TO }, 'missing_from', 'from'],
    ['to 없음', { from: FROM }, 'missing_to', 'to'],
    ['from 빈 값', { from: '', to: TO }, 'missing_from', 'from'],
    ['from 날짜 아님', { from: 'abc', to: TO }, 'invalid_from', 'from'],
    ['from 오프셋 없음', { from: '2026-11-01T00:00:00', to: TO }, 'invalid_from', 'from'],
    ['from 날짜만', { from: '2026-11-01', to: TO }, 'invalid_from', 'from'],
    ['from 없는 달', { from: '2026-13-01T00:00:00Z', to: TO }, 'invalid_from', 'from'],
    ['from 없는 날(2월 30일)', { from: '2026-02-30T00:00:00Z', to: TO }, 'invalid_from', 'from'],
    ['from 두 번', { from: [FROM, FROM], to: TO }, 'invalid_from', 'from'],
    ['to 날짜 아님', { from: FROM, to: 'tomorrow' }, 'invalid_to', 'to'],
    ['from = to', { from: FROM, to: FROM }, 'invalid_range', 'to'],
    ['from > to', { from: TO, to: FROM }, 'invalid_range', 'to'],
    ['92일 초과', { from: FROM, to: new Date(new Date(FROM).getTime() + 92 * DAY_MS + 1).toISOString() }, 'range_too_long', 'to'],
  ]
  for (const [label, params, code, field] of invalid) {
    it(`12. ${label} → 400 ${code} (field: ${field})`, async () => {
      const res = await events(a.agent, params).expect(400)

      assert.equal(res.body.error, code)
      assert.equal(res.body.field, field)
      assert.equal(typeof res.body.message, 'string')
    })
  }
})
