import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment, canvasFailures } from './helpers/fake-canvas.js'
import { networkError, timesOut } from './helpers/fake-google.js'
import {
  buildLmsApp,
  signedInUser,
  registerToken,
  tokenRow,
  onboardingStep,
  userLinks,
  testTokenCipher,
  TOKEN_PATH,
  STATUS_PATH,
  SYNC_PATH,
  CALENDAR_PATH,
  TOKEN_A,
  TOKEN_B,
} from './helpers/lms-context.js'

const DUE = '2026-11-20T14:59:00Z'

describe('POST /api/lms/token (Canvas 토큰 등록)', () => {
  let ctx
  let canvas
  let app
  let lms
  let clock

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    canvas = createFakeCanvas()
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '자료구조' })])
    canvas.setAssignments(TOKEN_A, 101, [canvasAssignment(101, 501, { dueAt: DUE })])
    ;({ app, lms, clock } = buildLmsApp(ctx, { canvas }))
  })
  after(async () => {
    await ctx.close()
  })

  it('로그인하지 않으면 토큰 · 상태 · 동기화 · 캘린더 모두 401 not_authenticated', async () => {
    const calls = [
      (r) => r.post(TOKEN_PATH).send({ token: TOKEN_A }),
      (r) => r.delete(TOKEN_PATH),
      (r) => r.get(STATUS_PATH),
      (r) => r.post(SYNC_PATH),
      (r) => r.get(`${CALENDAR_PATH}?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z`),
    ]
    for (const call of calls) {
      const res = await call(request(app))
      assert.equal(res.status, 401)
      assert.equal(res.body.error, 'not_authenticated')
    }
    assert.equal(canvas.requests.length, 0)
  })

  it('1. 올바른 토큰 → 202 syncing, 암호화 저장(원문 없음), onboarding done, 첫 동기화가 돌아 과제가 저장된다', async () => {
    const { agent, userId } = await signedInUser(app)

    const res = await registerToken(agent, TOKEN_A).expect(202)

    assert.deepEqual(res.body, { status: 'syncing' })
    assert.equal(canvas.requests[0].path, '/api/v1/users/self', '저장 전에 토큰을 확인한다')
    const row = await tokenRow(ctx.pool, userId)
    assert.ok(row.token_enc.startsWith('v1:') && !row.token_enc.includes(TOKEN_A))
    assert.equal(testTokenCipher().decrypt(row.token_enc, { userId }), TOKEN_A)
    assert.equal(await onboardingStep(ctx.pool, userId), 'done')

    await lms.syncRunner.whenIdle()

    assert.deepEqual(await userLinks(ctx.pool, userId), {
      courses: [101],
      assignments: [{ id: 501, dueAt: '2026-11-20T14:59:00.000Z' }],
      announcements: [],
    })
    const synced = await tokenRow(ctx.pool, userId)
    assert.equal(synced.status, 'ok')
    assert.equal(synced.last_error_code, null)
    assert.deepEqual(synced.last_synced_at, clock.now())
  })

  it('토큰 앞뒤 공백은 지우고 확인 · 저장한다', async () => {
    const { agent, userId } = await signedInUser(app)

    await registerToken(agent, `  ${TOKEN_A}\n`).expect(202)

    assert.equal(testTokenCipher().decrypt((await tokenRow(ctx.pool, userId)).token_enc, { userId }), TOKEN_A)
  })

  const invalidInputs = [
    ['token 없음', {}, 'missing_token'],
    ['빈 문자열', { token: '' }, 'missing_token'],
    ['공백만', { token: '   ' }, 'missing_token'],
    ['문자열 아님', { token: 12345 }, 'missing_token'],
    ['null', { token: null }, 'missing_token'],
    ['201자', { token: 'a'.repeat(201) }, 'token_too_long'],
    ['가운데 공백', { token: '7~abc def' }, 'invalid_token_format'],
    ['허용하지 않는 기호', { token: '7~abc;drop' }, 'invalid_token_format'],
    ['한글', { token: '7~토큰' }, 'invalid_token_format'],
    ['가운데 줄바꿈', { token: '7~abc\ndef' }, 'invalid_token_format'],
  ]
  for (const [label, body, code] of invalidInputs) {
    it(`입력 검사: ${label} → 400 ${code} (field: token), 저장 · Canvas 호출 없음`, async () => {
      const { agent } = await signedInUser(app)

      const res = await agent.post(TOKEN_PATH).send(body).expect(400)

      assert.equal(res.body.error, code)
      assert.equal(res.body.field, 'token')
      assert.equal(typeof res.body.message, 'string')
      assert.equal(await ctx.countRows('lms_tokens'), 0)
      assert.equal(canvas.requests.length, 0)
    })
  }

  it('200자는 길이 검사를 통과한다 (Canvas가 모르는 토큰이라 canvas_token_rejected)', async () => {
    const { agent } = await signedInUser(app)

    const res = await registerToken(agent, 'a'.repeat(200)).expect(400)

    assert.equal(res.body.error, 'canvas_token_rejected')
  })

  it('JSON이 아니면 415 unsupported_media_type', async () => {
    const { agent } = await signedInUser(app)

    const res = await agent.post(TOKEN_PATH).type('form').send(`token=${TOKEN_A}`).expect(415)

    assert.equal(res.body.error, 'unsupported_media_type')
    assert.equal(canvas.requests.length, 0)
  })

  const canvasFailureCases = [
    ['Canvas가 401 (모르는 · 취소된 토큰)', null, 400, 'canvas_token_rejected', 'token'],
    ['권한 없음 403', canvasFailures.forbidden, 400, 'canvas_token_rejected', 'token'],
    ['네트워크 오류', networkError, 502, 'canvas_unavailable', undefined],
    ['Canvas 500', canvasFailures.serverError, 502, 'canvas_unavailable', undefined],
    ['타임아웃', timesOut, 504, 'canvas_timeout', undefined],
    ['요청 제한 429', canvasFailures.rateLimited429, 503, 'canvas_rate_limited', undefined],
    ['요청 제한 403 + Rate Limit Exceeded', canvasFailures.rateLimited403, 503, 'canvas_rate_limited', undefined],
  ]
  for (const [label, respond, status, code, field] of canvasFailureCases) {
    it(`2. ${label} → ${status} ${code}, 아무것도 저장하지 않고 onboarding은 lms_token`, async () => {
      const { agent, userId } = await signedInUser(app)
      if (respond) {
        canvas.intercept((r) => r.path === '/api/v1/users/self', respond)
      }

      const res = await registerToken(agent, respond ? TOKEN_A : TOKEN_B).expect(status)
      await lms.syncRunner.whenIdle()

      assert.equal(res.body.error, code)
      assert.equal(res.body.field, field)
      assert.ok(!JSON.stringify(res.body).includes(TOKEN_A) && !JSON.stringify(res.body).includes(TOKEN_B))
      assert.equal(await tokenRow(ctx.pool, userId), null)
      assert.equal(await onboardingStep(ctx.pool, userId), 'lms_token')
      assert.equal(await ctx.countRows('courses'), 0)
      assert.equal(canvas.requests.length, 1, '확인 요청 하나뿐, 동기화 없음')
    })
  }

  it('다시 등록하면 토큰을 교체한다 (행은 하나, 새 암호문, 다시 syncing → ok)', async () => {
    const { agent, userId } = await signedInUser(app)
    await registerToken(agent, TOKEN_A).expect(202)
    await lms.syncRunner.whenIdle()
    const first = await tokenRow(ctx.pool, userId)
    canvas.addAccount(TOKEN_B, { id: 9001 })
    canvas.setCourses(TOKEN_B, [canvasCourse(101, { name: '자료구조' })])

    const res = await registerToken(agent, TOKEN_B).expect(202)

    assert.deepEqual(res.body, { status: 'syncing' })
    assert.equal(await ctx.countRows('lms_tokens'), 1)
    const second = await tokenRow(ctx.pool, userId)
    assert.notEqual(second.token_enc, first.token_enc)
    assert.equal(testTokenCipher().decrypt(second.token_enc, { userId }), TOKEN_B)
    await lms.syncRunner.whenIdle()
    assert.equal((await tokenRow(ctx.pool, userId)).status, 'ok')
    assert.deepEqual((await userLinks(ctx.pool, userId)).assignments, [], '새 토큰의 Canvas 목록 기준으로 다시 맞춘다')
  })
})
