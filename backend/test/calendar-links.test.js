import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { signedInUser, MINUTE_MS } from './helpers/lms-context.js'
import { icloudUrl, icloudFailures, ICLOUD_HOST } from './helpers/fake-icloud.js'
import { ics, vevent } from './helpers/ics-builder.js'
import { buildScheduleApp, registerLink, linkRows, liveSchedules, linkPath, linkSyncPath, ICLOUD_LINKS_PATH, LINKS_PATH, LINK_TOKEN_A, LINK_TOKEN_B } from './helpers/schedule-context.js'

const CALENDAR = ics(vevent({ uid: 'e1', summary: '동아리', start: '2026-11-20T10:00:00Z', end: '2026-11-20T11:00:00Z' }))
const tokenOf = (n) => `${LINK_TOKEN_A.slice(0, -4)}${String(n).padStart(4, '0')}`

// 등록 트랜잭션의 개수 세기(COUNT) 직후 첫 번째 트랜잭션만 잠깐 붙잡는 풀: 그 사이 두 번째 트랜잭션이 개수를 세게 해
// "둘 다 4개를 보고 둘 다 넣는" 경쟁을 강제로 만든다. 잠금이 있으면 두 번째는 users 행에서 기다린다
function createCountGatedPool(pool, { holdMs }) {
  const state = { counted: 0 }
  const wrap = (connection) =>
    new Proxy(connection, {
      get(target, prop) {
        if (prop === 'query' || prop === 'execute') {
          return async (sql, params) => {
            const result = await target[prop](sql, params)
            if (/COUNT\(\*\) AS total/.test(String(sql))) {
              state.counted += 1
              if (state.counted === 1) await new Promise((resolve) => setTimeout(resolve, holdMs))
            }
            return result
          }
        }
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  const gatedPool = { execute: (...args) => pool.execute(...args), query: (...args) => pool.query(...args), getConnection: async () => wrap(await pool.getConnection()) }
  return { pool: gatedPool, state }
}

// iCloud 연결 API (ADR 0010): 형식 검사 → 실제로 받아 파싱 → 암호화 저장 → 첫 동기화(백그라운드). URL은 응답에 없다
describe('iCloud 연결 API (/api/calendar/links)', () => {
  let ctx
  let built
  let a
  let b

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    built = buildScheduleApp(ctx)
    for (const token of [LINK_TOKEN_A, LINK_TOKEN_B, ...[1, 2, 3, 4, 5, 6].map(tokenOf)]) {
      built.icloud.setCalendar(token, CALENDAR)
    }
    a = await signedInUser(built.app, 'a@example.com')
    b = await signedInUser(built.app, 'b@example.com')
  })
  after(async () => {
    await ctx.close()
  })

  it('로그인하지 않으면 네 경로 모두 401', async () => {
    const anonymous = request(built.app)
    await anonymous.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(LINK_TOKEN_A) }).expect(401)
    await anonymous.get(LINKS_PATH).expect(401)
    await anonymous.delete(linkPath(1)).expect(401)
    await anonymous.post(linkSyncPath(1)).expect(401)
  })

  it('등록: 202 { id, provider, syncStatus }, 링크는 암호문으로만 저장(원문 · 토큰 없음), 해시는 키 없는 sha256이 아님, 첫 동기화로 일정이 들어온다', async () => {
    const res = await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))

    assert.equal(res.status, 202)
    assert.deepEqual({ ...res.body, id: undefined }, { id: undefined, provider: 'icloud', syncStatus: 'syncing' })
    assert.ok(!res.text.includes(LINK_TOKEN_A))
    const [row] = await linkRows(ctx.pool, a.userId)
    assert.match(row.url_enc, /^v1:/)
    assert.ok(!JSON.stringify(row).includes(LINK_TOKEN_A) && !JSON.stringify(row).includes(LINK_TOKEN_A.slice(0, 12)))
    const canonical = `https://${ICLOUD_HOST}/published/2/${LINK_TOKEN_A}`
    assert.notEqual(row.url_hash, createHash('sha256').update(canonical).digest('hex'), '키 없는 해시면 링크를 추측해 맞춰 볼 수 있음')
    assert.deepEqual((await liveSchedules(ctx.pool, a.userId)).map((s) => [s.source, s.title]), [['icloud', '동아리']])
    assert.equal((await linkRows(ctx.pool, a.userId))[0].sync_status, 'ok')
  })

  it('목록: 내 연결만, URL 관련 칸 없이 { id, provider, syncStatus, lastSyncedAt, lastErrorCode, createdAt }', async () => {
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))
    await registerLink(built, b.agent, icloudUrl(LINK_TOKEN_B))

    const res = await a.agent.get(LINKS_PATH).expect(200)

    assert.equal(res.body.links.length, 1)
    assert.deepEqual(Object.keys(res.body.links[0]).sort(), ['createdAt', 'id', 'lastErrorCode', 'lastSyncedAt', 'provider', 'syncStatus'])
    assert.deepEqual([res.body.links[0].provider, res.body.links[0].syncStatus, res.body.links[0].lastErrorCode], ['icloud', 'ok', null])
    for (const secret of [LINK_TOKEN_A, LINK_TOKEN_B, ICLOUD_HOST, 'published']) {
      assert.ok(!res.text.includes(secret), `목록 응답에 ${secret.slice(0, 8)}… 없음`)
    }
  })

  it('형식 검사 실패는 400 (field url), 아무것도 저장 · 요청하지 않음', async () => {
    const cases = [
      [undefined, 'missing_url'],
      ['', 'missing_url'],
      [`http://${ICLOUD_HOST}/published/2/${LINK_TOKEN_A}`, 'insecure_url'],
      ['https://evilicloud.com/published/2/x', 'host_not_allowed'],
      ['https://icloud.com.evil.com/published/2/x', 'host_not_allowed'],
      [`https://user@${ICLOUD_HOST}/published/2/x`, 'host_not_allowed'],
      [`https://${ICLOUD_HOST}:8443/published/2/x`, 'host_not_allowed'],
      ['https://127.0.0.1/published/2/x', 'host_not_allowed'],
      ['https://localhost/published/2/x', 'host_not_allowed'],
      ['https://192.168.0.1/published/2/x', 'host_not_allowed'],
      ['not a url', 'invalid_url'],
      [`https://${ICLOUD_HOST}/${'a'.repeat(1100)}`, 'url_too_long'],
    ]
    for (const [url, code] of cases) {
      const res = await a.agent.post(ICLOUD_LINKS_PATH).send({ url }).expect(400)
      assert.deepEqual([res.body.error, res.body.field], [code, 'url'], String(url))
    }
    assert.equal((await linkRows(ctx.pool, a.userId)).length, 0)
    assert.equal(built.icloud.requests.length + built.icloud.foreignRequests.length, 0)
  })

  it('받아 보기 실패는 저장하지 않고 코드로 응답: 400/404 → 400 icloud_link_invalid, 5xx → 502, 시간 초과 → 504, 요청 제한 → 503, HTML → 400, 깨진 ICS → 400, 밖으로 리다이렉트 → 400', async () => {
    const cases = [
      [icloudFailures.badRequest, 400, 'icloud_link_invalid'],
      [icloudFailures.notFound, 400, 'icloud_link_invalid'],
      [icloudFailures.serverError, 502, 'icloud_unavailable'],
      [icloudFailures.networkError, 502, 'icloud_unavailable'],
      [icloudFailures.timeoutError, 504, 'icloud_timeout'],
      [icloudFailures.rateLimited, 503, 'icloud_rate_limited'],
      [icloudFailures.html, 400, 'icloud_not_calendar'],
      [() => new Response('BEGIN:VCALENDAR\r\n', { headers: { 'Content-Type': 'text/calendar' } }), 400, 'icloud_parse_failed'],
      [() => icloudFailures.redirect('https://evil.example/x'), 400, 'icloud_redirect_rejected'],
    ]
    for (const [respond, status, code] of cases) {
      built.icloud.intercept(() => true, respond, { times: 1 })
      const res = await a.agent.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(LINK_TOKEN_A) }).expect(status)
      assert.deepEqual([res.body.error, res.body.field], [code, 'url'], code)
      assert.ok(!res.text.includes(LINK_TOKEN_A))
    }
    assert.equal((await linkRows(ctx.pool, a.userId)).length, 0)
    assert.deepEqual(built.icloud.foreignRequests, [])
  })

  it('같은 링크 다시 등록(webcal · https · 호스트 대문자 · :443 · 쿼리 붙임) → 409 calendar_link_already_registered, 다른 사용자는 같은 링크 등록 가능', async () => {
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))

    for (const url of [
      icloudUrl(LINK_TOKEN_A),
      icloudUrl(LINK_TOKEN_A, { scheme: 'https' }),
      `webcal://${ICLOUD_HOST.toUpperCase()}/published/2/${LINK_TOKEN_A}`,
      `https://${ICLOUD_HOST}:443/published/2/${LINK_TOKEN_A}`,
      `${icloudUrl(LINK_TOKEN_A)}?x=1`,
    ]) {
      assert.equal((await a.agent.post(ICLOUD_LINKS_PATH).send({ url }).expect(409)).body.error, 'calendar_link_already_registered', url.slice(0, 30))
    }
    await b.agent.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(LINK_TOKEN_A) }).expect(202)
    assert.equal((await linkRows(ctx.pool, a.userId)).length, 1)
  })

  it('사용자당 5개까지: 6번째는 409 calendar_link_limit_reached, 하나 지우면 다시 등록 가능', async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await a.agent.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(tokenOf(n)) }).expect(202)
    }

    assert.equal((await a.agent.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(tokenOf(6)) }).expect(409)).body.error, 'calendar_link_limit_reached')
    const [first] = await linkRows(ctx.pool, a.userId)
    await a.agent.delete(linkPath(first.id)).expect(204)
    await a.agent.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(tokenOf(6)) }).expect(202)
    assert.equal((await linkRows(ctx.pool, a.userId)).length, 5)
    await built.lms.calendarSyncRunner.whenIdle()
  })

  it('4개가 있을 때 두 링크를 동시에 등록하면 하나만 202, 하나는 409 (상한을 넘지 않음)', async () => {
    for (const n of [1, 2, 3, 4]) {
      await a.agent.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(tokenOf(n)) }).expect(202)
    }

    const results = await Promise.all([5, 6].map((n) => a.agent.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(tokenOf(n)) })))

    assert.deepEqual(results.map((r) => r.status).sort(), [202, 409])
    assert.equal((await linkRows(ctx.pool, a.userId)).length, 5)
    await built.lms.calendarSyncRunner.whenIdle()
  })

  it('동시 등록 경쟁을 강제해도(첫 트랜잭션이 개수를 센 뒤 멈춘 사이 두 번째가 셈) 상한 5개를 넘지 않는다 (users 행 잠금)', async () => {
    const gate = createCountGatedPool(ctx.pool, { holdMs: 300 })
    const gated = buildScheduleApp(ctx, { pool: gate.pool, icloud: built.icloud, clock: built.clock })
    const { agent, userId } = await signedInUser(gated.app, 'gated@example.com')
    for (const n of [1, 2, 3, 4]) {
      await agent.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(tokenOf(n)) }).expect(202)
    }
    await gated.lms.calendarSyncRunner.whenIdle()
    gate.state.counted = 0

    const results = await Promise.all([5, 6].map((n) => agent.post(ICLOUD_LINKS_PATH).send({ url: icloudUrl(tokenOf(n)) })))

    assert.deepEqual(results.map((r) => r.status).sort(), [202, 409])
    assert.equal((await linkRows(ctx.pool, userId)).length, 5)
    await gated.lms.calendarSyncRunner.whenIdle()
  })

  it('삭제: 204, 그 연결과 그 연결의 일정만 지운다. 다른 사용자 · 없는 · 형식이 틀린 id는 404 calendar_link_not_found', async () => {
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))
    built.icloud.setCalendar(LINK_TOKEN_B, ics(vevent({ uid: 'b1', summary: '개인', start: '2026-11-21T10:00:00Z', end: '2026-11-21T11:00:00Z' })))
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_B))
    const [first, second] = await linkRows(ctx.pool, a.userId)

    for (const id of [first.id + 1000, 'abc', '0']) {
      assert.equal((await a.agent.delete(linkPath(id)).expect(404)).body.error, 'calendar_link_not_found', String(id))
    }
    await b.agent.delete(linkPath(first.id)).expect(404)
    await a.agent.delete(linkPath(first.id)).expect(204)

    assert.deepEqual((await linkRows(ctx.pool, a.userId)).map((l) => l.id), [second.id])
    assert.deepEqual((await liveSchedules(ctx.pool, a.userId)).map((s) => s.title), ['개인'])
    const [[{ n }]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM schedules WHERE calendar_link_id = ?', [first.id])
    assert.equal(Number(n), 0, '지운 연결의 일정 행도 없음')
  })

  it('수동 동기화: 202, 5분 안에 다시 → 429 + Retry-After, 5분 지나면 다시 202. 다른 사용자 연결은 404', async () => {
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))
    const [link] = await linkRows(ctx.pool, a.userId)

    await a.agent.post(linkSyncPath(link.id)).expect(202)
    const tooSoon = await a.agent.post(linkSyncPath(link.id)).expect(429)
    assert.equal(tooSoon.body.error, 'sync_too_frequent')
    assert.ok(Number(tooSoon.headers['retry-after']) > 0 && Number(tooSoon.headers['retry-after']) <= 300)

    built.clock.advance(5 * MINUTE_MS)
    await a.agent.post(linkSyncPath(link.id)).expect(202)
    assert.equal((await b.agent.post(linkSyncPath(link.id)).expect(404)).body.error, 'calendar_link_not_found')
    await built.lms.calendarSyncRunner.whenIdle()
  })

  it('링크가 무효(iCloud 400)가 된 연결은 invalid · icloud_link_invalid, 수동 동기화는 409 calendar_link_invalid', async () => {
    await registerLink(built, a.agent, icloudUrl(LINK_TOKEN_A))
    const [link] = await linkRows(ctx.pool, a.userId)
    built.icloud.removeCalendar(LINK_TOKEN_A)

    await built.lms.calendarSync.syncUser(a.userId)

    const [after] = (await a.agent.get(LINKS_PATH).expect(200)).body.links
    assert.deepEqual([after.syncStatus, after.lastErrorCode], ['invalid', 'icloud_link_invalid'])
    assert.equal((await a.agent.post(linkSyncPath(link.id)).expect(409)).body.error, 'calendar_link_invalid')
  })
})
