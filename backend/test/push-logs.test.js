import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment } from './helpers/fake-canvas.js'
import { connectUser, TOKEN_A } from './helpers/lms-context.js'
import { FUTURE_1, FUTURE_2 } from './helpers/notification-context.js'
import { buildPushApp, makeSubscription, subscriptionBody, timeoutError, SUBSCRIPTIONS_PATH, PUSH_TEST_PATH, TEST_PUSH_CONFIG } from './helpers/push-context.js'

const TITLE_MARKER = 'PUSH-TITLE-MARKER-NOT-IN-LOGS'
const COURSE_MARKER = 'PUSH-COURSE-MARKER-NOT-IN-LOGS'

// 구독 주소 · 브라우저 키 · 푸시 내용 · VAPID 개인키는 로그에 남기지 않는다 (ADR 0012). 사용자 id · 결과 코드 · 개수만
describe('푸시 로그: 구독 주소 · 키 · 내용 없음', () => {
  let ctx

  before(async () => {
    ctx = await openTestContext()
    await ctx.resetDatabase()
  })
  after(async () => {
    await ctx.close()
  })

  it('등록 · 갱신 · 발송(성공 · 410 · 500 · 타임아웃) · 테스트 발송 · 해제 · 입력 오류 전 과정의 로그(trace까지)', async () => {
    const lines = []
    const canvas = createFakeCanvas()
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: COURSE_MARKER })])
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: TITLE_MARKER, dueAt: FUTURE_1 })])
    const built = buildPushApp(ctx, { canvas, logger: pino({ level: 'trace' }, { write: (line) => lines.push(line) }) })
    const a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    const subs = [makeSubscription(), makeSubscription(), makeSubscription(), makeSubscription({ host: 'web.push.apple.com', path: '/QOk1LogCheckSecretPath' })]
    for (const sub of subs) await a.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody(sub)).expect(201)
    await a.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody({ ...makeSubscription(), endpoint: subs[0].endpoint })).expect(200)
    await a.agent.post(SUBSCRIPTIONS_PATH).send({ ...subscriptionBody(subs[1]), endpoint: subs[1].endpoint.replace('fcm.googleapis.com', 'evil.example') }).expect(400)
    built.push.respond(subs[1].endpoint, 410)
    built.push.respond(subs[2].endpoint, 500)
    built.push.respond(subs[3].endpoint, () => Promise.reject(timeoutError()))

    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { name: TITLE_MARKER, dueAt: FUTURE_2 })])
    assert.equal((await built.lms.lmsSync.syncUser(a.userId)).outcome, 'applied')
    await built.lms.pushDispatcher.whenIdle()
    await a.agent.post(PUSH_TEST_PATH).expect(202)
    await built.lms.pushDispatcher.whenIdle()
    await a.agent.delete(SUBSCRIPTIONS_PATH).send({ endpoint: subs[0].endpoint }).expect(204)

    assert.ok(built.push.requests.length >= 4, '전제: 실제로 발송을 시도했다')
    assert.ok(lines.some((l) => l.includes('push_sent')), '전제: 발송 결과 로그가 남았다(개수)')
    const text = lines.join('\n')
    const secrets = [TITLE_MARKER, COURSE_MARKER, TEST_PUSH_CONFIG.vapidPrivateKey, 'QOk1LogCheckSecretPath', 'fcm.googleapis.com', 'web.push.apple.com']
    for (const sub of subs) secrets.push(sub.endpoint, sub.keys.p256dh, sub.keys.auth, sub.endpoint.split('/').at(-1))
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), `로그에 있으면 안 됨: ${secret.slice(0, 12)}…`)
    }
  })
})
