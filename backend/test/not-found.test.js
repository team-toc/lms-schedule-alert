import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'

const NOT_FOUND_BODY = { error: 'not_found', message: '요청한 API를 찾을 수 없습니다.' }

describe('/api 아래 매칭되는 라우트가 없으면 JSON 404', () => {
  let ctx
  let app

  before(async () => {
    ctx = await openTestContext()
    app = ctx.buildApp(createFakeKakaoClient())
  })
  after(async () => {
    await ctx.close()
  })

  const cases = [
    ['없는 경로 GET /api/nope', (r) => r.get('/api/nope')],
    ['없는 하위 경로 GET /api/auth/nope', (r) => r.get('/api/auth/nope')],
    ['있는 경로에 잘못된 메서드 GET /api/auth/logout', (r) => r.get('/api/auth/logout')],
    ['있는 경로에 잘못된 메서드 POST /api/auth/me', (r) => r.post('/api/auth/me')],
    ['있는 경로에 잘못된 메서드 DELETE /api/health', (r) => r.delete('/api/health')],
  ]
  for (const [label, send] of cases) {
    it(`${label} → 404 JSON not_found (405로 나누지 않음)`, async () => {
      const res = await send(request(app))

      assert.equal(res.status, 404)
      assert.match(res.headers['content-type'], /^application\/json/)
      assert.deepEqual(res.body, NOT_FOUND_BODY)
    })
  }

  it('있는 라우트는 그대로 동작한다', async () => {
    await request(app).get('/api/health').expect(200)
    await request(app).get('/api/auth/me').expect(401)
  })
})
