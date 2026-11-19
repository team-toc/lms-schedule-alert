import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext, FRONTEND_URL } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'
import { login, SESSION_COOKIE_NAME } from './helpers/auth-flow.js'

const DAY_MS = 24 * 60 * 60 * 1000
const CLOCK_TOLERANCE_MS = 60 * 1000

function rawSessionCookie(res) {
  return (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
}

function expiresOf(rawCookie) {
  return Date.parse(rawCookie.match(/Expires=([^;]+)/)[1])
}

describe('세션 쿠키 · 프록시 · CORS', () => {
  let ctx

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
  })
  after(async () => {
    await ctx.close()
  })

  it('개발 설정: 쿠키에 Secure가 없다 (http 로컬 개발)', async () => {
    const res = await request(ctx.buildApp(createFakeKakaoClient())).get('/api/auth/kakao').expect(302)

    assert.doesNotMatch(rawSessionCookie(res), /Secure/i)
  })

  it('운영 설정 + 프록시 신뢰: nginx가 https로 넘긴 요청에 Secure 쿠키를 발급한다', async () => {
    const config = { ...ctx.config, isProduction: true, trustProxy: true }
    const app = ctx.buildApp(createFakeKakaoClient(), { config })

    const res = await request(app).get('/api/auth/kakao').set('X-Forwarded-Proto', 'https').expect(302)

    assert.match(rawSessionCookie(res), /Secure/i)
  })

  it('운영 설정인데 프록시 신뢰를 끄면 프록시 뒤에서 세션 쿠키가 발급되지 않는다 (설정이 필요한 이유)', async () => {
    const config = { ...ctx.config, isProduction: true, trustProxy: false }
    const app = ctx.buildApp(createFakeKakaoClient(), { config })

    const res = await request(app).get('/api/auth/kakao').set('X-Forwarded-Proto', 'https').expect(302)

    assert.equal(rawSessionCookie(res), undefined)
  })

  it('세션 유지 기간은 설정값(기본 7일)이다', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient()))

    const { res } = await login(agent)

    const expected = Date.now() + 7 * DAY_MS
    assert.equal(ctx.config.session.ttlMs, 7 * DAY_MS)
    assert.ok(Math.abs(expiresOf(rawSessionCookie(res)) - expected) < CLOCK_TOLERANCE_MS)
  })

  it('rolling: 로그인 후 요청마다 쿠키 만료를 다시 연장해 내려준다', async () => {
    const agent = request.agent(ctx.buildApp(createFakeKakaoClient()))
    await login(agent)

    const me = await agent.get('/api/auth/me').expect(200)

    const refreshed = rawSessionCookie(me)
    assert.ok(refreshed, '/me 응답에도 만료가 연장된 쿠키가 있어야 함')
    assert.ok(Math.abs(expiresOf(refreshed) - (Date.now() + ctx.config.session.ttlMs)) < CLOCK_TOLERANCE_MS)
  })

  it('CORS를 열지 않는다: 다른 출처 요청에 Access-Control-Allow-* 헤더가 없다', async () => {
    const app = ctx.buildApp(createFakeKakaoClient())

    const res = await request(app).get('/api/auth/me').set('Origin', FRONTEND_URL)
    const preflight = await request(app)
      .options('/api/auth/logout')
      .set('Origin', FRONTEND_URL)
      .set('Access-Control-Request-Method', 'POST')

    for (const r of [res, preflight]) {
      assert.equal(r.headers['access-control-allow-origin'], undefined)
      assert.equal(r.headers['access-control-allow-credentials'], undefined)
    }
  })
})
