import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient, DEFAULT_PROFILE } from './helpers/fake-kakao-client.js'
import { login } from './helpers/auth-flow.js'

describe('로그인 상태 확인 · 로그아웃', () => {
  let ctx
  let app

  before(async () => {
    ctx = await openTestContext()
    app = ctx.buildApp(createFakeKakaoClient())
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
  })
  after(async () => {
    await ctx.close()
  })

  it('6. 로그인 후 /api/auth/me → 200 + 사용자 정보', async () => {
    const agent = request.agent(app)
    await login(agent)
    const [[user]] = await ctx.pool.query('SELECT id FROM users')

    const res = await agent.get('/api/auth/me').expect(200)

    assert.deepEqual(res.body, { id: user.id, displayName: DEFAULT_PROFILE.nickname, onboardingStep: 'lms_token' })
  })

  it('7. 비로그인 /api/auth/me → 401 not_authenticated', async () => {
    const res = await request(app).get('/api/auth/me').expect(401)

    assert.equal(res.body.error, 'not_authenticated')
    assert.ok(res.body.message)
  })

  it('8. 로그아웃 후 이전 쿠키로 /api/auth/me → 401', async () => {
    const agent = request.agent(app)
    const { cookie } = await login(agent)

    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(204)

    const cleared = logoutRes.headers['set-cookie']?.find((c) => c.startsWith('sid='))
    assert.ok(cleared, '로그아웃 응답이 쿠키를 지워야 함')
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/)
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401)
    assert.equal(await ctx.countRows('sessions'), 0)
  })

  it('8-1. 이미 로그아웃된 상태에서 로그아웃 → 401 already_logged_out', async () => {
    const res = await request(app).post('/api/auth/logout').expect(401)

    assert.equal(res.body.error, 'already_logged_out')
    assert.ok(res.body.message)
  })

  it('9. 로그인 후 사용자를 DB에서 삭제 → 기존 쿠키로 /api/auth/me → 401, 세션도 삭제됨', async () => {
    const agent = request.agent(app)
    const { cookie } = await login(agent)
    assert.equal(await ctx.countRows('sessions'), 1)
    await ctx.pool.query('DELETE FROM users')

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401)

    assert.equal(res.body.error, 'not_authenticated')
    assert.equal(await ctx.countRows('sessions'), 0)
  })

  it('에러 응답과 /me 응답에 세션 ID · 토큰이 들어가지 않는다', async () => {
    const agent = request.agent(app)
    const { cookie } = await login(agent)
    const sessionId = decodeURIComponent(cookie.split('=')[1])

    const me = await agent.get('/api/auth/me').expect(200)

    const body = JSON.stringify(me.body)
    assert.ok(!body.includes(sessionId))
    assert.ok(!body.includes('fake-access-token'))
  })
})
