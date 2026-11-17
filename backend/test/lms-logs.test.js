import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasFailures, canvasResponse } from './helpers/fake-canvas.js'
import { networkError } from './helpers/fake-google.js'
import { buildLmsApp, signedInUser, registerToken, tokenRow, TOKEN_PATH, STATUS_PATH, SYNC_PATH, MINUTE_MS, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'

function createCapturingLogger() {
  const entries = []
  const logger = pino({ level: 'trace' }, { write: (line) => entries.push(JSON.parse(line)) })
  return { logger, entries }
}

// 로그 · 응답 어디에도 나오면 안 되는 것: 토큰 원문 · 앞뒤 일부 · 해시 · base64, Authorization 헤더
function forbiddenFragments(token) {
  return [
    token,
    token.slice(0, 12),
    token.slice(-12),
    createHash('sha256').update(token).digest('hex'),
    createHash('sha256').update(token).digest('base64'),
    createHash('sha1').update(token).digest('hex'),
    Buffer.from(token).toString('base64'),
  ]
}

// 전제: 검사할 흐름이 실제로 돌았다 (로그가 비어 있어서 "없다"가 저절로 참이 되지 않게)
function assertFlowWasLogged(entries) {
  const events = new Set(entries.map((e) => e.event))
  for (const event of ['lms_token_rejected', 'lms_token_registered', 'lms_sync_failed']) {
    assert.ok(events.has(event), `전제: ${event} 로그가 있어야 검사가 의미 있음`)
  }
}

describe('13. 로그 · 응답에 토큰 · 토큰 일부 · Authorization 헤더가 없다', () => {
  let ctx
  let capture
  const responses = []
  let tokenEnc

  before(async () => {
    ctx = await openTestContext()
    await ctx.resetDatabase()
    capture = createCapturingLogger()
    const canvas = createFakeCanvas()
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101), canvasCourse(102)])
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501)])
    const built = buildLmsApp(ctx, { canvas, logger: capture.logger })
    const record = (res) => {
      responses.push(JSON.stringify({ body: res.body, headers: res.headers, text: res.text }))
      return res
    }
    const { agent, userId } = await signedInUser(built.app)

    // 거부되는 토큰(401), 정상 등록 + 첫 동기화
    record(await registerToken(agent, TOKEN_B))
    record(await registerToken(agent, TOKEN_A))
    await built.lms.syncRunner.whenIdle()
    tokenEnc = (await tokenRow(ctx.pool, userId))?.token_enc ?? 'v1:not-stored'
    record(await agent.get(STATUS_PATH))

    // 실패하는 동기화: Canvas가 오류 본문에 토큰을 되돌려 보내는 경우 · 네트워크 오류 · 요청 제한 · 401
    canvas.intercept((r) => r.path === '/api/v1/courses', () => canvasResponse(500, { errors: [{ message: `token ${TOKEN_A} invalid` }] }), { times: 1 })
    await built.lms.lmsSync.syncUser(userId)
    canvas.intercept((r) => r.path === '/api/v1/courses/102/assignments', networkError, { times: 1 })
    await built.lms.lmsSync.syncUser(userId)
    canvas.intercept((r) => r.path === '/api/v1/courses', canvasFailures.rateLimited403, { times: 1 })
    record(await agent.post(SYNC_PATH))
    await built.lms.syncRunner.whenIdle()
    built.clock.advance(10 * MINUTE_MS)
    canvas.intercept((r) => r.path === '/api/v1/courses', canvasFailures.unauthorized, { times: 1 })
    await built.lms.syncRunner.runOnce()
    record(await agent.get(STATUS_PATH))
    record(await agent.delete(TOKEN_PATH))
  })
  after(async () => {
    await ctx.close()
  })

  it('남는 로그에 토큰 원문 · 앞뒤 12자 · SHA-256/SHA-1 해시 · base64 · 암호문이 없다', () => {
    assertFlowWasLogged(capture.entries)
    const text = JSON.stringify(capture.entries)

    for (const fragment of [...forbiddenFragments(TOKEN_A), ...forbiddenFragments(TOKEN_B), tokenEnc]) {
      assert.ok(!text.includes(fragment), `로그에 금지된 값: ${fragment.slice(0, 6)}…`)
    }
  })

  it('Authorization 헤더 · Bearer · 요청 본문이 로그에 없다', () => {
    assertFlowWasLogged(capture.entries)
    const text = JSON.stringify(capture.entries)

    assert.doesNotMatch(text, /authorization/i)
    assert.doesNotMatch(text, /bearer/i)
    assert.ok(capture.entries.every((e) => e.req === undefined || e.req.body === undefined), '요청 본문 금지')
  })

  it('응답 본문 · 헤더에도 토큰 · 일부 · 해시 · 암호문이 없다', () => {
    assert.ok(tokenEnc !== 'v1:not-stored', '전제: 토큰이 저장되어 있었어야 함')
    const text = responses.join('\n')

    for (const fragment of [...forbiddenFragments(TOKEN_A), ...forbiddenFragments(TOKEN_B), tokenEnc]) {
      assert.ok(!text.includes(fragment), `응답에 금지된 값: ${fragment.slice(0, 6)}…`)
    }
  })

  it('원인 파악에 필요한 것(사건 이름 · userId · 고정 오류 코드)은 남는다', () => {
    const userEvents = ['lms_token_rejected', 'lms_token_registered', 'lms_sync_applied', 'lms_sync_failed', 'lms_token_deleted']
    const events = capture.entries.map((e) => e.event)

    for (const event of userEvents) {
      assert.ok(events.includes(event), `${event} 로그가 있어야 함`)
    }
    const codes = capture.entries.filter((e) => e.event === 'lms_sync_failed').map((e) => e.errorCode)
    for (const code of ['canvas_unavailable', 'canvas_rate_limited', 'canvas_unauthorized']) {
      assert.ok(codes.includes(code), `lms_sync_failed에 ${code}`)
    }
    assert.ok(capture.entries.filter((e) => userEvents.includes(e.event)).every((e) => Number.isInteger(e.userId)), '사용자 사건에는 userId')
  })
})
