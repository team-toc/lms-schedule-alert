import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'

const BROKEN_JSON = '{"note": "secret-body-MUST-NOT-LEAK", '

describe('깨진 JSON 요청 (전체 /api)', () => {
  let ctx

  before(async () => {
    ctx = await openTestContext()
  })
  after(async () => {
    await ctx.close()
  })

  it('POST /api/auth/logout에 깨진 JSON → 400 invalid_json (500 아님), 본문 내용을 돌려주지 않음', async () => {
    const entries = []
    const logger = pino({ level: 'trace' }, { write: (line) => entries.push(line) })
    const app = ctx.buildApp(createFakeKakaoClient(), { logger })

    const res = await request(app).post('/api/auth/logout').set('Content-Type', 'application/json').send(BROKEN_JSON).expect(400)

    assert.deepEqual(res.body, { error: 'invalid_json', message: '요청 본문이 올바른 JSON이 아닙니다.' })
    const logText = entries.join('')
    assert.ok(!logText.includes('secret-body-MUST-NOT-LEAK'), '본문 내용이 로그에 남으면 안 됨')
    assert.ok(!logText.includes('"level":50'), '클라이언트 잘못이라 error 레벨 로그가 아니어야 함')
  })
})
