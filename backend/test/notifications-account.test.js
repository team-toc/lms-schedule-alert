import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasResponse } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, registerToken, tokenRow, TOKEN_PATH, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'
import { changes, change, countNotifications, FUTURE_1, FUTURE_2 } from './helpers/notification-context.js'

const TOKEN_A2 = TOKEN_A.replace('AAAA', 'aaaa')
// 2^53 = 9007199254740992. 아래 둘은 Number로 바꾸면 같은 값이 된다(마지막 자리만 다름)
const BIG_ID = '9007199254740993'
const BIG_ID_NEIGHBOR = '9007199254740992'
const SELF_PATH = '/api/v1/users/self'

// 토큰 교체 · 재등록 · 연동 해제 (ADR 0009 4 · 5절): 같은 Canvas 계정이면 정상 감지, 다르거나 알 수 없으면 기준 동기화 + 이전 알림 삭제
describe('알림과 Canvas 계정: 교체 · 재등록 · 연동 해제', () => {
  let ctx
  let canvas
  let built
  let a
  const assignment = (dueAt, name = '과제 1') => canvasAssignment(101, 501, { name, dueAt })

  function account(token, id, dueAt = FUTURE_1) {
    canvas.addAccount(token, { id })
    canvas.setCourses(token, [canvasCourse(101, { name: '자료구조' })])
    canvas.setAssignments(token, 101, [assignment(dueAt)])
  }

  // A가 연결된 뒤 제목 변경 알림 1건이 있는 상태
  async function connectWithOneNotification(token = TOKEN_A) {
    a = await connectUser(built, { email: 'a@example.com', token })
    canvas.setAssignments(token, 101, [assignment(FUTURE_1, '과제 1 (수정)')])
    await built.lms.lmsSync.syncUser(a.userId)
    assert.equal(await countNotifications(ctx.pool, a.userId), 1, '전제: 알림 1건')
  }

  async function replaceToken(token) {
    await registerToken(a.agent, token).expect(202)
    await built.lms.syncRunner.whenIdle()
  }

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    canvas = createFakeCanvas()
    built = buildLmsApp(ctx, { canvas })
  })
  after(async () => {
    await ctx.close()
  })

  it('토큰 등록 때 /users/self의 id를 문자열로 저장한다 (2^53을 넘어도 정확히)', async () => {
    account(TOKEN_A, BIG_ID)

    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })

    assert.equal((await tokenRow(ctx.pool, a.userId)).canvas_user_id, BIG_ID)
  })

  it('같은 계정의 다른 토큰으로 교체 + 끊긴 사이 마감 변경 → 1건, 기존 알림도 그대로', async () => {
    account(TOKEN_A, 9001)
    await connectWithOneNotification()
    account(TOKEN_A2, 9001, FUTURE_2)
    canvas.setAssignments(TOKEN_A2, 101, [assignment(FUTURE_2, '과제 1 (수정)')])

    await replaceToken(TOKEN_A2)

    assert.deepEqual(await changes(ctx.pool, a.userId), [
      change('assignment_title_changed', 'assignment:501', { beforeTitle: '과제 1', afterTitle: '과제 1 (수정)' }),
      change('assignment_due_changed', 'assignment:501', { beforeDueAt: FUTURE_1, afterDueAt: FUTURE_2 }),
    ])
  })

  it('같은 토큰을 다시 등록해도(같은 계정) 정상 감지 → 그 사이 변경 1건', async () => {
    account(TOKEN_A, 9001)
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    canvas.setAssignments(TOKEN_A, 101, [assignment(FUTURE_2)])

    await replaceToken(TOKEN_A)

    assert.deepEqual((await changes(ctx.pool, a.userId)).map((c) => c.kind), ['assignment_due_changed'])
  })

  it('다른 계정 토큰으로 교체 → 이전 알림 전부 삭제(등록 응답 시점에 이미), 새 계정 첫 동기화는 기준(0건), 그다음부터 감지', async () => {
    account(TOKEN_A, 9001)
    await connectWithOneNotification()
    account(TOKEN_B, 9002, FUTURE_2)

    await registerToken(a.agent, TOKEN_B).expect(202)
    assert.equal(await countNotifications(ctx.pool, a.userId), 0, '토큰 저장과 같은 트랜잭션에서 삭제')
    await built.lms.syncRunner.whenIdle()
    assert.equal(await countNotifications(ctx.pool, a.userId), 0, '다른 계정의 마감 차이를 변경으로 보지 않음')

    canvas.setAssignments(TOKEN_B, 101, [assignment(FUTURE_1)])
    await built.lms.lmsSync.syncUser(a.userId)
    assert.equal(await countNotifications(ctx.pool, a.userId), 1)
  })

  it('큰 id: 마지막 자리만 다른 두 id는 다른 계정 → 0건 · 이전 알림 삭제', async () => {
    account(TOKEN_A, BIG_ID)
    await connectWithOneNotification()
    account(TOKEN_B, BIG_ID_NEIGHBOR, FUTURE_2)

    await replaceToken(TOKEN_B)

    assert.equal(await countNotifications(ctx.pool, a.userId), 0)
    assert.equal((await tokenRow(ctx.pool, a.userId)).canvas_user_id, BIG_ID_NEIGHBOR)
  })

  it('큰 id: 같은 큰 id는 같은 계정 → 정상 감지 1건 · 이전 알림 유지', async () => {
    account(TOKEN_A, BIG_ID)
    await connectWithOneNotification()
    account(TOKEN_A2, BIG_ID, FUTURE_2)
    canvas.setAssignments(TOKEN_A2, 101, [assignment(FUTURE_2, '과제 1 (수정)')])

    await replaceToken(TOKEN_A2)

    assert.equal(await countNotifications(ctx.pool, a.userId), 2)
  })

  it('저장된 계정 id가 없으면(마이그레이션 전 행) 같은 계정이어도 기준 동기화 → 0건 · 이전 알림 삭제', async () => {
    account(TOKEN_A, 9001)
    await connectWithOneNotification()
    await ctx.pool.query('UPDATE lms_tokens SET canvas_user_id = NULL WHERE user_id = ?', [a.userId])
    canvas.setAssignments(TOKEN_A, 101, [assignment(FUTURE_2, '과제 1 (수정)')])

    await replaceToken(TOKEN_A)

    assert.equal(await countNotifications(ctx.pool, a.userId), 0)
    assert.equal((await tokenRow(ctx.pool, a.userId)).canvas_user_id, '9001', '이번에 받은 id는 저장')
  })

  it('새 토큰의 /users/self에 id가 없으면 → 계정 id NULL, 기준 동기화 0건 · 이전 알림 삭제', async () => {
    account(TOKEN_A, 9001)
    await connectWithOneNotification()
    account(TOKEN_A2, undefined, FUTURE_2)

    await replaceToken(TOKEN_A2)

    assert.equal((await tokenRow(ctx.pool, a.userId)).canvas_user_id, null)
    assert.equal(await countNotifications(ctx.pool, a.userId), 0)
  })

  it('id를 믿을 수 없는 응답(문자열 헤더를 무시하고 2^53 넘는 숫자 · 0 · 음수 · 앞자리 0 · 소수 · 객체) → NULL로 저장, 안전 범위 숫자는 문자열로', async () => {
    account(TOKEN_A, 9001)
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    const cases = [
      ['{"id":9007199254740993}', null],
      ['{"id":0}', null],
      ['{"id":-5}', null],
      ['{"id":"0123"}', null],
      ['{"id":1.5}', null],
      ['{"id":{"x":1}}', null],
      ['{"id":"12a"}', null],
      ['{"id":9001}', '9001'],
    ]
    for (const [body, expected] of cases) {
      canvas.intercept((r) => r.path === SELF_PATH, () => canvasResponse(200, body), { times: 1 })
      await registerToken(a.agent, TOKEN_A).expect(202)
      await built.lms.syncRunner.whenIdle()
      assert.equal((await tokenRow(ctx.pool, a.userId)).canvas_user_id, expected, body)
    }
  })

  it('계정 id를 쓸 수 없어 NULL로 저장하면 경고 로그(이유 코드만, id 값 없음), 정상 id면 경고 없음', async () => {
    const lines = []
    built = buildLmsApp(ctx, { canvas, logger: pino({ level: 'trace' }, { write: (line) => lines.push(line) }) })
    account(TOKEN_A, 9001)
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    const warnings = () => lines.map((line) => JSON.parse(line)).filter((e) => e.event === 'lms_canvas_account_id_unusable')
    assert.deepEqual(warnings(), [], '정상 id는 경고 없음')

    for (const [body, reason] of [
      ['{"id":9007199254740993}', 'unsafe_number'],
      ['{"name":"학생"}', 'missing'],
      ['{"id":"0123"}', 'invalid_format'],
    ]) {
      canvas.intercept((r) => r.path === SELF_PATH, () => canvasResponse(200, body), { times: 1 })
      await replaceToken(TOKEN_A)
      assert.deepEqual(
        warnings().map(({ level, userId, reason: r }) => ({ level, userId, reason: r })).at(-1),
        { level: 40, userId: a.userId, reason },
        body,
      )
    }
    const text = lines.join('\n')
    for (const leaked of ['9007199254740993', '9007199254740992']) {
      assert.ok(!text.includes(leaked), `로그에 id 값이 있으면 안 됨: ${leaked}`)
    }
  })

  it('9. 연동 해제 → 내 알림 전부 삭제(다른 사용자 알림은 그대로), 다시 등록하면 기준 동기화 0건', async () => {
    account(TOKEN_A, 9001)
    account(TOKEN_B, 9002)
    const b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
    canvas.setAssignments(TOKEN_B, 101, [assignment(FUTURE_2)])
    await built.lms.lmsSync.syncUser(b.userId)
    await connectWithOneNotification()

    await a.agent.delete(TOKEN_PATH).expect(204)
    assert.equal(await countNotifications(ctx.pool, a.userId), 0)
    assert.equal(await countNotifications(ctx.pool, b.userId), 1)

    canvas.setAssignments(TOKEN_A, 101, [assignment(FUTURE_2, '과제 1 (또 수정)')])
    await replaceToken(TOKEN_A)
    assert.equal(await countNotifications(ctx.pool, a.userId), 0, '해제 뒤 재등록은 새 등록 → 기준 동기화')
  })
})
