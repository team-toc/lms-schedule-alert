import { describe, it, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment } from './helpers/fake-canvas.js'
import { buildLmsApp, signedInUser, registerToken, connectUser, tokenRow, TOKEN_A } from './helpers/lms-context.js'

const INJECTED_MESSAGE = 'injected failure MUST-NOT-LOG'

// 진짜 풀을 감싸, fault.active인 동안 트랜잭션 연결의 과제 upsert에서 예상 밖 DB 에러를 던진다
function createFaultyPool(pool, fault) {
  const wrapConnection = (connection) =>
    new Proxy(connection, {
      get(target, prop) {
        if (prop === 'query') {
          return async (sql, params) => {
            if (fault.active && String(sql).startsWith('INSERT INTO assignments')) {
              throw Object.assign(new Error(INJECTED_MESSAGE), { code: 'ER_INJECTED_FAILURE' })
            }
            return target.query(sql, params)
          }
        }
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  return {
    execute: (...args) => pool.execute(...args),
    query: (...args) => pool.query(...args),
    getConnection: async () => wrapConnection(await pool.getConnection()),
  }
}

function createCapturingLogger() {
  const entries = []
  return { entries, logger: pino({ level: 'trace' }, { write: (line) => entries.push(JSON.parse(line)) }) }
}

describe('백그라운드 동기화의 예상 밖 에러', () => {
  let ctx
  let canvas
  let built
  let fault
  let capture
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)

  before(async () => {
    ctx = await openTestContext()
    process.on('unhandledRejection', onUnhandled)
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    unhandled.length = 0
    fault = { active: false }
    capture = createCapturingLogger()
    canvas = createFakeCanvas()
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101)])
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501)])
    built = buildLmsApp(ctx, { canvas, logger: capture.logger, pool: createFaultyPool(ctx.pool, fault) })
  })
  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [], '처리되지 않은 Promise 거부가 없어야 함')
  })
  after(async () => {
    process.off('unhandledRejection', onUnhandled)
    await ctx.close()
  })

  it('첫 동기화(토큰 등록 직후)에서 DB 에러 → 반영 없음, failing · internal_error, 앱은 계속 응답한다', async () => {
    const { agent, userId } = await signedInUser(built.app)
    fault.active = true

    await registerToken(agent, TOKEN_A).expect(202)
    await built.lms.syncRunner.whenIdle()

    const row = await tokenRow(ctx.pool, userId)
    assert.equal(row.status, 'failing')
    assert.equal(row.last_error_code, 'internal_error')
    assert.equal(await ctx.countRows('courses'), 0, '트랜잭션이 롤백되어 과목도 남지 않는다')
    await agent.get('/api/auth/me').expect(200)
  })

  it('직접 부른 동기화도 던지지 않고 { failed, internal_error }를 돌려준다, 에러가 사라지면 다음 동기화는 ok', async () => {
    const { userId } = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    fault.active = true

    assert.deepEqual(await built.lms.lmsSync.syncUser(userId), { outcome: 'failed', errorCode: 'internal_error' })
    assert.equal((await tokenRow(ctx.pool, userId)).status, 'failing')

    fault.active = false
    assert.deepEqual(await built.lms.lmsSync.syncUser(userId), { outcome: 'applied' })
    assert.equal((await tokenRow(ctx.pool, userId)).status, 'ok')
  })

  it('주기 실행(runOnce)에서 DB 에러 → 그 사용자는 failing으로 기록하고 다음 사용자로 넘어간다, 앱은 계속 응답한다', async () => {
    const a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    canvas.addAccount('7~SecondUser0123456789abcdef', { id: 9002 })
    canvas.setCourses('7~SecondUser0123456789abcdef', [canvasCourse(102)])
    const b = await connectUser(built, { email: 'b@example.com', token: '7~SecondUser0123456789abcdef' })
    fault.active = true

    const summary = await built.lms.syncRunner.runOnce()

    assert.deepEqual(summary, { total: 2, applied: 1, failed: 1, skipped: 0 }, 'A(과제 있음)만 실패, B(과제 없음)는 반영')
    assert.equal((await tokenRow(ctx.pool, a.userId)).last_error_code, 'internal_error')
    assert.equal((await tokenRow(ctx.pool, b.userId)).status, 'ok')
    await a.agent.get('/api/auth/me').expect(200)
  })

  it('로그에는 사건 이름 · 에러 이름 · 코드만 남고, 에러 메시지(SQL 값이 들어갈 수 있음)는 남지 않는다', async () => {
    const { userId } = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    fault.active = true

    await built.lms.lmsSync.syncUser(userId)

    const crashed = capture.entries.find((e) => e.event === 'lms_sync_crashed')
    assert.ok(crashed, 'lms_sync_crashed 로그가 있어야 함')
    assert.equal(crashed.userId, userId)
    assert.deepEqual(crashed.err, { name: 'Error', code: 'ER_INJECTED_FAILURE' })
    assert.ok(!JSON.stringify(capture.entries).includes(INJECTED_MESSAGE))
  })
})
