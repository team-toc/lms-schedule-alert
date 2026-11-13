import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasAnnouncement } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, DAY_MS, TOKEN_A } from './helpers/lms-context.js'
import { NOTIFICATIONS_PATH, READ_ALL_PATH, FUTURE_1, FUTURE_2 } from './helpers/notification-context.js'

const TITLE_MARKER = 'TITLE-MARKER-NOT-IN-LOGS'
const BODY_MARKER = 'BODY-MARKER-NOT-IN-LOGS'

// 10. 변경 감지 · 알림 API 로그에 토큰 · 제목 · 본문이 없고, 동기화 로그에는 알림 개수만 (ADR 0009 가정 절)
describe('알림 로그: 토큰 · 제목 · 본문 없음', () => {
  let ctx
  const lines = []

  before(async () => {
    ctx = await openTestContext()
    await ctx.resetDatabase()
  })
  after(async () => {
    await ctx.close()
  })

  it('감지 · 목록 · 읽음 전 과정의 로그(trace까지)에 토큰 원문 · 일부, 제목, 공지 본문이 없다', async () => {
    const logger = pino({ level: 'trace' }, { write: (line) => lines.push(line) })
    const canvas = createFakeCanvas()
    const built = buildLmsApp(ctx, { canvas, logger })
    const posted = new Date(built.clock.now().getTime() - DAY_MS).toISOString()
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101)])
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: `과제 ${TITLE_MARKER}`, dueAt: FUTURE_1 })])
    canvas.setAnnouncements(TOKEN_A, 101, [canvasAnnouncement(101, 701, { title: `공지 ${TITLE_MARKER}`, message: `<p>${BODY_MARKER}</p>`, postedAt: posted })])
    const a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })

    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: `과제 ${TITLE_MARKER} 2`, dueAt: FUTURE_2 })])
    canvas.setAnnouncements(TOKEN_A, 101, [canvasAnnouncement(101, 701, { title: `공지 ${TITLE_MARKER}`, message: `<p>${BODY_MARKER} 2</p>`, postedAt: posted })])
    await built.lms.lmsSync.syncUser(a.userId)
    const listed = await a.agent.get(NOTIFICATIONS_PATH).expect(200)
    await a.agent.post(`${NOTIFICATIONS_PATH}/${listed.body.notifications[0].id}/read`).expect(204)
    await a.agent.post(READ_ALL_PATH).expect(204)

    const text = lines.join('\n')
    for (const secret of [TOKEN_A, TOKEN_A.slice(0, 12), TOKEN_A.slice(-12), TITLE_MARKER, BODY_MARKER]) {
      assert.ok(!text.includes(secret), `로그에 있으면 안 됨: ${secret.slice(0, 4)}…`)
    }
    const applied = lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'lms_sync_applied')
    assert.equal(applied.at(-1).notifications, 3, '동기화 로그에는 알림 개수만')
  })
})
