import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'

const BODY_MARKER = 'secret-body-MUST-NOT-LEAK'
const BODY_LIMIT_BYTES = 100 * 1024
const LOGIN_PATH = '/api/auth/email/login'
const WARN_LEVEL = 40
const ERROR_LEVEL = 50

function createCapturingLogger() {
  const entries = []
  const logger = pino({ level: 'trace' }, { write: (line) => entries.push(JSON.parse(line)) })
  return { logger, entries, text: () => JSON.stringify(entries) }
}

describe('요청 본문 오류 → 알맞은 4xx (전역 에러 처리)', () => {
  let ctx

  before(async () => {
    ctx = await openTestContext()
  })
  after(async () => {
    await ctx.close()
  })

  const cases = [
    {
      label: '본문 100KB 초과',
      status: 413,
      body: { error: 'payload_too_large', message: '요청 본문이 너무 큽니다. 최대 100KB까지 보낼 수 있습니다.' },
      send: (r) =>
        r
          .post(LOGIN_PATH)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ email: 'a@example.com', password: BODY_MARKER.repeat(Math.ceil(BODY_LIMIT_BYTES / BODY_MARKER.length) + 10) })),
    },
    {
      label: '지원하지 않는 문자셋 (charset=iso-8859-1)',
      status: 415,
      body: { error: 'unsupported_charset', message: '지원하지 않는 문자셋입니다. UTF-8로 보내 주세요.' },
      send: (r) => r.post(LOGIN_PATH).set('Content-Type', 'application/json; charset=iso-8859-1').send(`{"note":"${BODY_MARKER}"}`),
    },
    {
      label: '지원하지 않는 Content-Encoding',
      status: 415,
      body: { error: 'unsupported_encoding', message: '지원하지 않는 Content-Encoding입니다.' },
      send: (r) =>
        r.post(LOGIN_PATH).set('Content-Type', 'application/json').set('Content-Encoding', 'x-unknown').send(`{"note":"${BODY_MARKER}"}`),
    },
    {
      label: '깨진 JSON (기존 동작 유지)',
      status: 400,
      body: { error: 'invalid_json', message: '요청 본문이 올바른 JSON이 아닙니다.' },
      send: (r) => r.post(LOGIN_PATH).set('Content-Type', 'application/json').send(`{"note":"${BODY_MARKER}", `),
    },
  ]
  for (const { label, status, body, send } of cases) {
    it(`${label} → ${status} ${body.error}, warn 로그, 본문 내용은 기록 안 함`, async () => {
      const capture = createCapturingLogger()
      const app = ctx.buildApp(createFakeKakaoClient(), { logger: capture.logger })

      const res = await send(request(app))

      assert.equal(res.status, status)
      assert.deepEqual(res.body, body)
      const rejected = capture.entries.filter((e) => e.event === 'request_body_rejected')
      assert.equal(rejected.length, 1)
      assert.equal(rejected[0].level, WARN_LEVEL)
      assert.equal(rejected[0].reason, body.error)
      assert.ok(!capture.entries.some((e) => e.level >= ERROR_LEVEL), '클라이언트 잘못이라 error 로그가 아니어야 함')
      assert.ok(!capture.text().includes(BODY_MARKER), '본문 내용이 로그에 있음')
    })
  }

  it('표에 없는 오류는 500 internal_error, 응답에 내부 정보(에러 메시지 · 스택)를 넣지 않는다', async () => {
    const internalDetail = 'internal-detail-MUST-NOT-LEAK: Lost connection to 10.0.0.5'
    const brokenRepository = {
      findUserById: async () => null,
      findUserByIdentity: async () => null,
      createUserWithIdentity: async () => null,
      createUserWithPassword: async () => null,
      findEmailCredential: async () => {
        throw new Error(internalDetail)
      },
    }
    const app = ctx.buildApp(createFakeKakaoClient(), { userRepository: brokenRepository })

    const res = await request(app).post(LOGIN_PATH).send({ email: 'a@example.com', password: 'whatever pw' })

    assert.equal(res.status, 500)
    assert.deepEqual(Object.keys(res.body).sort(), ['error', 'message', 'requestId'])
    assert.equal(res.body.error, 'internal_error')
    assert.equal(res.body.requestId, res.headers['x-request-id'])
    assert.ok(!res.text.includes('internal-detail') && !res.text.includes('at '), '내부 정보가 응답에 있음')
  })
})
