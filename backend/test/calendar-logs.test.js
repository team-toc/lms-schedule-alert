import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { signedInUser } from './helpers/lms-context.js'
import { icloudUrl, icloudFailures, ICLOUD_HOST } from './helpers/fake-icloud.js'
import { ics, vevent } from './helpers/ics-builder.js'
import { buildScheduleApp, linkRows, linkPath, linkSyncPath, ICLOUD_LINKS_PATH, LINKS_PATH, EVENTS_PATH, LINK_TOKEN_A } from './helpers/schedule-context.js'

const TITLE_MARKER = 'ICLOUD-TITLE-NOT-IN-LOGS'

// iCloud 링크는 비밀번호와 같다 (ADR 0010): 로그 · 응답 · 에러 어디에도 원문 · 일부가 없어야 한다
describe('iCloud 로그: 링크 원문 · 일부 · 일정 제목 없음', () => {
  let ctx

  before(async () => {
    ctx = await openTestContext()
    await ctx.resetDatabase()
  })
  after(async () => {
    await ctx.close()
  })

  it('등록 · 동기화 · 실패(받기 · 파싱 · 리다이렉트 거부) · 목록 · 수동 동기화 · 삭제 전 과정의 로그(trace까지)와 응답에 링크가 없다', async () => {
    const lines = []
    const built = buildScheduleApp(ctx, { logger: pino({ level: 'trace' }, { write: (line) => lines.push(line) }) })
    built.icloud.setCalendar(LINK_TOKEN_A, ics(vevent({ uid: 'u', summary: TITLE_MARKER, start: '2026-11-20T01:00:00Z', end: '2026-11-20T02:00:00Z' })))
    const a = await signedInUser(built.app, 'a@example.com')
    const url = icloudUrl(LINK_TOKEN_A)
    const responses = []
    const keep = (res) => {
      responses.push(res.text)
      return res
    }

    for (const respond of [icloudFailures.serverError, icloudFailures.timeoutError, () => icloudFailures.redirect('https://evil.example/x'), () => new Response('x', { headers: { 'Content-Type': 'text/calendar' } })]) {
      built.icloud.intercept(() => true, respond, { times: 1 })
      keep(await a.agent.post(ICLOUD_LINKS_PATH).send({ url }))
    }
    keep(await a.agent.post(ICLOUD_LINKS_PATH).send({ url: `http://${ICLOUD_HOST}/published/2/${LINK_TOKEN_A}` }))
    keep(await a.agent.post(ICLOUD_LINKS_PATH).send({ url }).expect(202))
    await built.lms.calendarSyncRunner.whenIdle()
    built.icloud.intercept(() => true, icloudFailures.serverError, { times: 1 })
    await built.lms.calendarSync.syncUser(a.userId)
    built.icloud.removeCalendar(LINK_TOKEN_A)
    await built.lms.calendarSync.syncUser(a.userId)
    const [link] = await linkRows(ctx.pool, a.userId)
    keep(await a.agent.get(LINKS_PATH).expect(200))
    keep(await a.agent.post(linkSyncPath(link.id)))
    keep(await a.agent.get(EVENTS_PATH).query({ from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }))
    keep(await a.agent.delete(linkPath(link.id)).expect(204))
    await built.lms.calendarSyncRunner.whenIdle()

    assert.ok(lines.some((l) => l.includes('calendar_sync')), '전제: 동기화 로그가 실제로 남았다')
    const logText = lines.join('\n')
    for (const secret of [
      LINK_TOKEN_A,
      LINK_TOKEN_A.slice(0, 12),
      LINK_TOKEN_A.slice(-12),
      `${ICLOUD_HOST}/published`,
      'published/2/',
      Buffer.from(LINK_TOKEN_A).toString('base64').slice(0, 16),
      TITLE_MARKER,
    ]) {
      assert.ok(!logText.includes(secret), `로그에 있으면 안 됨: ${secret.slice(0, 6)}…`)
    }
    for (const text of responses) {
      assert.ok(!text.includes(LINK_TOKEN_A) && !text.includes('published/2/'), '응답에 링크가 있으면 안 됨')
    }
  })
})
