import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAnnouncement } from './helpers/fake-canvas.js'
import { connectUser, registerToken, DAY_MS, TOKEN_A, TOKEN_PATH } from './helpers/lms-context.js'
import { buildSuggestionApp, suggestionRows, countRows, acceptPath } from './helpers/suggestion-context.js'

const TOKEN_A2 = TOKEN_A.replace('AAAA', 'aaaa')
const BODY = '<p>중간고사는 11월 20일 오후 2시</p><p>퀴즈는 11월 27일</p>'

// 연동 해제 · 토큰 교체와 제안 (ADR 0011 리뷰 결정 4): 교체는 lms_tokens 행 UPDATE라 제안이 남고, 해제는 CASCADE로 지워지며 만든 앱 일정은 남는다
describe('공지 일정 제안: 토큰 교체 · 연동 해제', () => {
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
    built = buildSuggestionApp(ctx, { canvas })
    const posted = new Date(built.clock.now().getTime() - DAY_MS).toISOString()
    for (const token of [TOKEN_A, TOKEN_A2]) {
      canvas.addAccount(token, { id: 9001 })
      canvas.setCourses(token, [canvasCourse(101, { name: '자료구조' })])
      canvas.setAnnouncements(token, 101, [canvasAnnouncement(101, 701, { title: '시험 안내', message: BODY, postedAt: posted })])
    }
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
  })
  after(async () => {
    await ctx.close()
  })

  it('같은 계정 토큰으로 교체 · 같은 토큰 재등록 → 제안 행이 그대로(id · 상태 · 수락 기록 포함)', async () => {
    const [first] = await suggestionRows(ctx.pool, a.userId)
    await a.agent.post(acceptPath(first.id)).send({}).expect(201)
    const before = (await suggestionRows(ctx.pool, a.userId)).map((r) => [r.id, r.status, r.schedule_id])

    await registerToken(a.agent, TOKEN_A2).expect(202)
    await built.lms.syncRunner.whenIdle()
    await registerToken(a.agent, TOKEN_A2).expect(202)
    await built.lms.syncRunner.whenIdle()

    assert.deepEqual((await suggestionRows(ctx.pool, a.userId)).map((r) => [r.id, r.status, r.schedule_id]), before)
  })

  it('연동 해제 → 제안 · 훑은 기록 모두 삭제, 수락해서 만든 앱 일정은 남는다 (events에도 그대로)', async () => {
    const [first] = await suggestionRows(ctx.pool, a.userId)
    const { body } = await a.agent.post(acceptPath(first.id)).send({}).expect(201)

    await a.agent.delete(TOKEN_PATH).expect(204)

    assert.equal(await countRows(ctx.pool, 'suggestions', a.userId), 0)
    assert.equal(await countRows(ctx.pool, 'announcement_scans', a.userId), 0)
    const [[schedule]] = await ctx.pool.query('SELECT source, deleted_at FROM schedules WHERE id = ?', [body.schedule.id])
    assert.deepEqual({ ...schedule }, { source: 'app', deleted_at: null })
    const events = (await a.agent.get('/api/calendar/events').query({ from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }).expect(200)).body.events
    assert.deepEqual(events.map((e) => [e.source, e.id]), [['app', body.schedule.id]])
  })

  it('해제 뒤 다시 연동하면 제안을 새로 만든다 (예전 수락 · 거절 기록은 남아 있지 않음)', async () => {
    await a.agent.delete(TOKEN_PATH).expect(204)

    await registerToken(a.agent, TOKEN_A).expect(202)
    await built.lms.syncRunner.whenIdle()

    assert.deepEqual((await suggestionRows(ctx.pool, a.userId)).map((r) => r.status), ['pending', 'pending'])
  })
})
