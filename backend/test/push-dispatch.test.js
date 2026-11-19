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

// 동기화 → 푸시 (ADR 0012): 반영이 커밋된 뒤 잠금 안에서 대상만 읽고, 발송은 잠금을 푼 뒤 백그라운드에서.
// 대상 = 이번 동기화가 만들거나 갱신한 안 읽은 알림(detected_at = 동기화 시각, 밀리초까지). 실패해도 동기화 · 알림 저장은 그대로
describe('동기화 뒤 푸시 발송', () => {
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

  it('새 알림 1건 → 내 구독마다 1번(Topic = 알림 id), 내용 { v, notificationId, kind, title, body, url }, 다른 사용자 구독에는 안 감', async () => {
    const b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
    const subB = makeSubscription()
    await b.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody(subB)).expect(201)
    // 6단계에서 보강(백업과 다름): B도 같은 시각(밀리초까지 같음)에 동기화해 B의 알림이 생긴다 — A의 발송 대상에 섞이면 안 됨
    canvas.setAssignments(TOKEN_B, 101, [assignment(501), assignment(502, FUTURE_2), assignment(503), assignment(504)])
    await built.lms.lmsSync.syncUser(b.userId)
    setAssignmentsA([assignment(501, FUTURE_2), assignment(502), assignment(503), assignment(504)])

    assert.equal((await syncA()).outcome, 'applied')

    const [id] = await notificationIds(a.userId)
    const [idB] = await notificationIds(b.userId)
    for (const sub of subsA) {
      assert.deepEqual(payloads(sub), [{ v: 1, notificationId: id, kind: 'assignment_due_changed', title: '마감 변경', body: `${COURSE} · 과제 1 · 11/27 23:59`, url: NOTIFICATION_URL }])
      assert.equal(built.push.to(sub.endpoint)[0].headers.get('topic'), `n${id}`)
    }
    assert.deepEqual(payloads(subB).map((p) => p.notificationId), [idB], 'B에게는 B의 알림만, A의 알림은 안 감')
  })

  it('알림이 없는 동기화 → 0번', async () => {
    assert.equal((await syncA()).outcome, 'applied')
    assert.equal(built.push.requests.length, 0)
  })

  it('정밀도: 밀리초가 있는 시각의 동기화 → 그 동기화 알림만, 1ms 뒤 변화 없는 동기화는 0번, 합쳐진 알림(마감 또 바뀜)은 같은 id로 다시', async () => {
    setAssignmentsA([assignment(501, FUTURE_2), assignment(502), assignment(503), assignment(504)])
    await syncA()
    const [id] = await notificationIds(a.userId)
    const [[stored]] = await ctx.pool.query('SELECT detected_at FROM notifications WHERE id = ?', [id])
    assert.equal(stored.detected_at.toISOString(), '2026-11-13T00:00:00.123Z', '밀리초까지 저장')
    assert.equal(built.push.requests.length, 2)

    built.clock.advance(1)
    await syncA()
    assert.equal(built.push.requests.length, 2, '앞 동기화의 안 읽은 알림을 다시 보내지 않음')

    built.clock.advance(1)
    setAssignmentsA([assignment(501, '2026-12-04T14:59:00.000Z'), assignment(502), assignment(503), assignment(504)])
    await syncA()
    assert.deepEqual(await notificationIds(a.userId), [id], '합쳐짐(알림 하나)')
    assert.deepEqual(payloads(subsA[0]).map((p) => [p.notificationId, p.body]), [
      [id, `${COURSE} · 과제 1 · 11/27 23:59`],
      [id, `${COURSE} · 과제 1 · 12/4 23:59`],
    ])
  })

  it('종류별 제목: 한 동기화에 3개(마감 변경 · 새 과제 · 과제 삭제)면 하나씩', async () => {
    setAssignmentsA([assignment(501, FUTURE_2), assignment(503), assignment(504), assignment(505)])

    await syncA()

    assert.deepEqual(payloads(subsA[0]).map((p) => p.title).sort(), ['과제 삭제', '마감 변경', '새 과제'].sort())
  })

  it('한 동기화에 4개 이상이면 구독마다 요약 1개(notificationId null, Topic summary)', async () => {
    setAssignmentsA([501, 502, 503, 504].map((id) => assignment(id, FUTURE_2)))

    await syncA()

    for (const sub of subsA) {
      const list = payloads(sub)
      assert.equal(list.length, 1)
      assert.deepEqual({ ...list[0], body: undefined }, { v: 1, notificationId: null, kind: 'summary', count: 4, title: '새 알림 4개', body: undefined, url: NOTIFICATION_URL })
      assert.equal(built.push.to(sub.endpoint)[0].headers.get('topic'), 'summary')
    }
  })

  it('내용: 공지 본문은 넣지 않고, 긴 제목 · 과목 이름은 잘라 1024바이트 이하', async () => {
    const marker = '공지본문-푸시에-나오면-안-됨'
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: `${COURSE}${'과'.repeat(250)}` })])
    canvas.setAnnouncements(TOKEN_A, 101, [canvasAnnouncement(101, 701, { title: `중간고사 안내${'가'.repeat(250)}`, message: `<p>${marker}</p>`, postedAt: new Date(built.clock.now().getTime() - DAY_MS).toISOString() })])

    await syncA()

    const [req] = built.push.to(subsA[0].endpoint)
    const text = JSON.stringify(built.push.payloadOf(req, subsA[0]))
    const payload = JSON.parse(text)
    assert.equal(payload.kind, 'announcement_created')
    assert.equal(payload.title, '새 공지')
    assert.match(payload.body, /^자료구조/)
    assert.match(payload.body, /중간고사 안내/)
    assert.ok(!text.includes(marker), '공지 본문 없음')
    assert.ok(Buffer.byteLength(text, 'utf8') <= 1024, `${Buffer.byteLength(text, 'utf8')}바이트`)
  })

  it('발송은 잠금 밖: 푸시가 붙잡혀 있는 동안에도 같은 사용자 동기화가 돈다(already_running 아님)', async () => {
    const held = built.push.hold()
    setAssignmentsA([assignment(501, FUTURE_2), assignment(502), assignment(503), assignment(504)])
    try {
      assert.equal((await built.lms.lmsSync.syncUser(a.userId)).outcome, 'applied')
      await held.reached(2)
      assert.equal((await built.lms.lmsSync.syncUser(a.userId)).outcome, 'applied')
    } finally {
      held.release()
    }
    await built.lms.pushDispatcher.whenIdle()
  })

  it('보내기 직전 주인 재확인: 읽은 뒤 같은 브라우저에서 다른 계정이 구독해 주인이 바뀐 구독 → 0번, 그대로인 구독은 정상', async () => {
    await setup({ subscriptions: 5 })
    const b = await signedInUser(built.app, 'b@example.com')
    const held = built.push.hold()
    setAssignmentsA([assignment(501, FUTURE_2), assignment(502), assignment(503), assignment(504)])
    try {
      await built.lms.lmsSync.syncUser(a.userId)
      await held.reached(4)
      // 5번째 구독은 아직 대기 중(동시 4개). 그 사이 B가 같은 브라우저(endpoint)로 등록
      await b.agent.post(SUBSCRIPTIONS_PATH).send(subscriptionBody({ ...makeSubscription(), endpoint: subsA[4].endpoint })).expect(200)
    } finally {
      held.release()
    }
    await built.lms.pushDispatcher.whenIdle()

    // 6단계에서 고침(백업과 다름): 동시 4개는 보내기 전 DB 다시 읽기가 끝나는 순서대로 도착해 순서는 정해지지 않는다 → 집합으로 비교
    const sortedUrls = () => built.push.requests.map((r) => r.url).sort()
    assert.deepEqual(sortedUrls(), subsA.slice(0, 4).map((s) => s.endpoint).sort())
    assert.equal(built.push.to(subsA[4].endpoint).length, 0, '주인이 바뀐 구독으로 A의 알림이 가면 안 됨')
  })

  it(`대기열 상한(기본 ${MAX_PENDING_PUSHES}): 넘으면 가장 오래된 대기 일감부터 버리고 경고(개수만), 대기열이 상한을 넘지 않는다`, async () => {
    assert.equal(MAX_PENDING_PUSHES, 1000)
    await setup({ maxPending: 3, subscriptions: 10 })
    const held = built.push.hold()
    setAssignmentsA([assignment(501, FUTURE_2), assignment(502), assignment(503), assignment(504)])
    try {
      await built.lms.lmsSync.syncUser(a.userId)
      await held.reached(4)
      assert.equal(built.lms.pushDispatcher.pendingCount(), 3)
    } finally {
      held.release()
    }
    await built.lms.pushDispatcher.whenIdle()

    // 동시 4개는 바로 시작, 나머지 6개 중 오래된 3개(5 · 6 · 7번째)를 버림
    // 6단계에서 고침(백업과 다름): 도착 순서는 정해지지 않는다(동시 발송) → 집합으로 비교
    assert.deepEqual(built.push.requests.map((r) => r.url).sort(), [...subsA.slice(0, 4), ...subsA.slice(7)].map((s) => s.endpoint).sort())
    const overflow = events('push_queue_overflow')
    assert.equal(overflow.reduce((sum, e) => sum + e.dropped, 0), 3)
    assert.ok(!JSON.stringify(overflow).includes('https://'))
  })
})
