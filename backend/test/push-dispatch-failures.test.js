import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasAnnouncement } from './helpers/fake-canvas.js'
import { connectUser, signedInUser, createLmsClock, DAY_MS, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'
import { FUTURE_1, FUTURE_2 } from './helpers/notification-context.js'
import { MAX_PENDING_PUSHES } from '../src/push/push-dispatcher.js'
import { buildPushApp, makeSubscription, subscriptionBody, pushRows, timeoutError, SUBSCRIPTIONS_PATH, PUSH_TEST_PATH, NOTIFICATION_URL } from './helpers/push-context.js'

const COURSE = '자료구조'
const assignment = (id, dueAt = FUTURE_1) => canvasAssignment(101, id, { name: `과제 ${id - 500}`, dueAt })

// 동기화 → 푸시 실패 (ADR 0012): 404 · 410 삭제, 그 밖은 연속 실패만, 발송 · 단계 실패는 동기화 · 알림 저장 · 제안에 영향 없음.
// (push-dispatch.test.js가 300줄을 넘어 6단계에서 나눔, 준비 코드는 같음)
describe('동기화 뒤 푸시 발송: 실패 · 격리', () => {
  let ctx
  let canvas
  let built
  let lines
  let a
  let subsA

  before(async () => {
    ctx = await openTestContext()
  })

  // 밀리초가 있는 시각으로 시작한다(정밀도 확인). maxPending은 대기열 상한 테스트에서만
  async function setup({ clockMs = Date.UTC(2026, 10, 13, 0, 0, 0, 123), maxPending, subscriptions = 2 } = {}) {
    await ctx.resetDatabase()
    lines = []
    canvas = createFakeCanvas()
    for (const [token, id] of [
      [TOKEN_A, 9001],
      [TOKEN_B, 9002],
    ]) {
      canvas.addAccount(token, { id })
      canvas.setCourses(token, [canvasCourse(101, { name: COURSE })])
      canvas.setAssignments(token, 101, [501, 502, 503, 504].map((id) => assignment(id)))
    }
    built = buildPushApp(ctx, { canvas, clock: createLmsClock(clockMs), maxPending, logger: pino({ level: 'trace' }, { write: (line) => lines.push(line) }) })
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    subsA = []
    for (let i = 0; i < subscriptions; i += 1) {
      subsA.push(makeSubscription())
      await a.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody(subsA.at(-1))).expect(201)
    }
  }
  beforeEach(() => setup())
  after(async () => {
    await ctx.close()
  })

  const setAssignmentsA = (list) => canvas.setAssignments(TOKEN_A, 101, list)
  const syncA = async () => {
    const result = await built.lms.lmsSync.syncUser(a.userId)
    await built.lms.pushDispatcher.whenIdle()
    return result
  }
  const notificationIds = async (userId) => (await ctx.pool.query('SELECT id FROM notifications WHERE user_id = ? ORDER BY id', [userId]))[0].map((r) => r.id)
  const payloads = (sub) => built.push.to(sub.endpoint).map((req) => built.push.payloadOf(req, sub))
  const events = (name) => lines.map((l) => JSON.parse(l)).filter((e) => e.event === name)

  it('실패: 410 · 404 → 그 구독 삭제, 500 · 타임아웃 → 연속 실패 +1 · 코드 기록, 성공하면 0으로. 동기화 · 알림 저장은 그대로', async () => {
    subsA.push(makeSubscription(), makeSubscription())
    for (const sub of subsA.slice(2)) await a.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody(sub)).expect(201)
    built.push.respond(subsA[0].endpoint, 410)
    built.push.respond(subsA[1].endpoint, 404)
    built.push.respond(subsA[2].endpoint, 500)
    built.push.respond(subsA[3].endpoint, () => Promise.reject(timeoutError()))
    setAssignmentsA([assignment(501, FUTURE_2), assignment(502), assignment(503), assignment(504)])

    assert.equal((await syncA()).outcome, 'applied')
    assert.equal((await notificationIds(a.userId)).length, 1, '알림은 저장됨')
    const rows = await pushRows(ctx.pool, a.userId)
    assert.deepEqual(rows.map((r) => [r.consecutive_failures, r.last_failure_code, r.last_success_at]), [
      [1, 'http_500', null],
      [1, 'timeout', null],
    ])

    built.push.respond(subsA[2].endpoint, 201)
    built.push.respond(subsA[3].endpoint, 201)
    // 6단계에서 고침(백업과 다름): 원래 마감(FUTURE_1)으로 되돌리면 안 읽은 알림이 "되돌림"으로 지워져(ADR 0009) 보낼 것이 없다 → 다른 날짜로
    setAssignmentsA([assignment(501, '2026-12-04T14:59:00.000Z'), assignment(502), assignment(503), assignment(504)])
    await syncA()
    assert.deepEqual((await pushRows(ctx.pool, a.userId)).map((r) => [r.consecutive_failures, r.last_success_at?.toISOString()]), [
      [0, built.clock.now().toISOString()],
      [0, built.clock.now().toISOString()],
    ])
  })

  it('모든 발송이 예외로 끝나도 동기화는 applied, 알림은 저장', async () => {
    built.push.respondAll(() => {
      throw new Error('push service exploded')
    })
    setAssignmentsA([assignment(501, FUTURE_2), assignment(502), assignment(503), assignment(504)])

    assert.equal((await syncA()).outcome, 'applied')
    assert.equal((await notificationIds(a.userId)).length, 1)
  })

  // 6단계에서 더함(백업에 없던 테스트): 훅 단계는 따로 잡는다 — 발송 준비 단계가 DB 오류로 실패해도 제안 단계는 돌고 동기화는 applied
  it('발송 준비 단계가 실패해도(대상 조회 DB 오류) 동기화는 applied, 제안 단계는 그대로 돌고, 단계 실패는 코드만 로그', async () => {
    const failing = new Proxy(ctx.pool, {
      get(target, prop) {
        if (prop !== 'execute') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop]
        return (sql, params) => {
          if (String(sql).includes('n.detected_at = ?')) return Promise.reject(Object.assign(new Error('push target query exploded'), { code: 'ER_PUSH_TEST' }))
          return target.execute(sql, params)
        }
      },
    })
    await ctx.resetDatabase()
    lines = []
    canvas = createFakeCanvas()
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: COURSE })])
    canvas.setAssignments(TOKEN_A, 101, [assignment(501)])
    built = buildPushApp(ctx, { canvas, pool: failing, logger: pino({ level: 'trace' }, { write: (line) => lines.push(line) }) })
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    await a.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody(makeSubscription())).expect(201)
    canvas.setAssignments(TOKEN_A, 101, [assignment(501, FUTURE_2)])
    canvas.setAnnouncements(TOKEN_A, 101, [canvasAnnouncement(101, 701, { title: '중간고사 안내', message: '<p>중간고사는 11월 20일 오후 2시</p>', postedAt: new Date(built.clock.now().getTime() - DAY_MS).toISOString() })])
    lines.length = 0

    assert.equal((await syncA()).outcome, 'applied')

    assert.equal(built.push.requests.length, 0)
    const [[{ n }]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM suggestions WHERE user_id = ?', [a.userId])
    assert.equal(Number(n), 1, '제안 단계는 돌았다')
    const failed = events('after_applied_step_failed')
    assert.deepEqual(failed.map((e) => [e.step, e.err]), [['push', { name: 'Error', code: 'ER_PUSH_TEST' }]])
    assert.ok(!lines.join('\n').includes('push target query exploded'), '에러 메시지는 로그에 없음')
  })

  // 6단계에서 더함(백업에 없던 테스트): 일감 하나가 발송기 안에서 던져도(저장된 암호문을 풀 수 없음 — 키를 바꾼 경우 등) 그 일감만 실패
  it('구독 하나의 암호문을 풀 수 없어도 그 구독만 실패로 세고, 다른 구독은 보내며 동기화는 applied, 로그는 코드만', async () => {
    await ctx.pool.query("UPDATE push_subscriptions SET subscription_enc = 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = (SELECT MIN(id) FROM (SELECT id FROM push_subscriptions) t)")
    setAssignmentsA([assignment(501, FUTURE_2), assignment(502), assignment(503), assignment(504)])

    assert.equal((await syncA()).outcome, 'applied')

    assert.deepEqual(built.push.requests.map((r) => r.url), [subsA[1].endpoint])
    assert.deepEqual(events('push_dispatch_failed').map((e) => [e.userId, e.err.name]), [[a.userId, 'TokenDecryptError']])
    const [batch] = events('push_sent')
    assert.deepEqual([batch.sent, batch.failed], [1, 1])
  })

  it('연속 실패가 5번에 닿는 순간 경고 한 번(사용자 id · 횟수만), 6번째는 경고 없음', async () => {
    built.push.respondAll(500)
    for (let i = 0; i < 6; i += 1) {
      await a.agent.post(PUSH_TEST_PATH).expect(202)
      await built.lms.pushDispatcher.whenIdle()
    }

    const warned = events('push_subscription_failing')
    assert.equal(warned.length, subsA.length, '구독마다 한 번')
    for (const event of warned) {
      assert.deepEqual([event.userId, event.failures], [a.userId, 5])
      assert.ok(!JSON.stringify(event).includes('https://'))
    }
  })
})
