import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAnnouncement, CANVAS_BASE_URL } from './helpers/fake-canvas.js'
import { connectUser, DAY_MS, MINUTE_MS, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'
import { buildSuggestionApp, insertSuggestion, announcementId, suggestionRows, SUGGESTIONS_PATH, acceptPath, rejectPath } from './helpers/suggestion-context.js'

// 시계: 2026-11-13T00:00Z(서울 09:00)
const FUTURE = { startAt: '2026-11-20T05:00:00.000Z', endAt: '2026-11-20T06:00:00.000Z' }
const BODY_MARKER = '본문-응답에-나오면-안-됨'

// 제안 API (ADR 0011): 내 것만, 만료는 계산, 수락 = 앱 일정(앱 일정과 같은 입력 검사), 한 번만 처리
describe('제안 API (/api/suggestions)', () => {
  let ctx
  let built
  let a
  let b
  let aid

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    const canvas = createFakeCanvas()
    built = buildSuggestionApp(ctx, { canvas })
    const posted = new Date(built.clock.now().getTime() - DAY_MS).toISOString()
    for (const [token, id] of [
      [TOKEN_A, 9001],
      [TOKEN_B, 9002],
    ]) {
      canvas.addAccount(token, { id })
      canvas.setCourses(token, [canvasCourse(101, { name: '자료구조' })])
      // 날짜 없는 공지: 제안은 직접 넣는다
      canvas.setAnnouncements(token, 101, [canvasAnnouncement(101, 701, { title: '중간고사 안내', message: `<p>${BODY_MARKER}</p>`, postedAt: posted })])
    }
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
    aid = await announcementId(ctx.pool, 701)
  })
  after(async () => {
    await ctx.close()
  })

  const add = (user, fields = {}) => insertSuggestion(ctx.pool, { userId: user.userId, announcementId: aid, ...FUTURE, ...fields })
  const list = (agent, query = {}) => agent.get(SUGGESTIONS_PATH).query(query)

  it('로그인하지 않으면 세 경로 모두 401', async () => {
    const anonymous = request(built.app)
    await anonymous.get(SUGGESTIONS_PATH).expect(401)
    await anonymous.post(acceptPath(1)).send({}).expect(401)
    await anonymous.post(rejectPath(1)).expect(401)
  })

  it('목록 항목 모양: 과목 · 공지 제목 · 종류 · 상태 · 제안 시각(UTC) · 맥락 · Canvas 링크, 공지 본문 없음', async () => {
    const id = await add(a, { kind: 'exam', context: '중간고사는 11월 20일 오후 2시' })

    const res = await list(a.agent).expect(200)

    assert.deepEqual(res.body, {
      suggestions: [
        {
          id,
          kind: 'exam',
          status: 'pending',
          courseName: '자료구조',
          announcementTitle: '중간고사 안내',
          startAt: FUTURE.startAt,
          endAt: FUTURE.endAt,
          isAllDay: false,
          startDate: null,
          endDate: null,
          context: '중간고사는 11월 20일 오후 2시',
          url: `${CANVAS_BASE_URL}/courses/101/discussion_topics/701`,
          scheduleId: null,
          createdAt: res.body.suggestions[0].createdAt,
          decidedAt: null,
        },
      ],
      nextCursor: null,
    })
    assert.ok(!res.text.includes(BODY_MARKER))
  })

  it('내 제안만, 기본은 대기(pending), status로 accepted · rejected · expired 필터, 잘못된 값 400', async () => {
    const pending = await add(a)
    const accepted = await add(a, { status: 'accepted', startAt: '2026-11-21T05:00:00Z', endAt: '2026-11-21T06:00:00Z' })
    const rejected = await add(a, { status: 'rejected', startAt: '2026-11-22T05:00:00Z', endAt: '2026-11-22T06:00:00Z' })
    await add(b)

    const ids = async (query) => (await list(a.agent, query).expect(200)).body.suggestions.map((s) => s.id)
    assert.deepEqual(await ids({}), [pending])
    assert.deepEqual(await ids({ status: 'accepted' }), [accepted])
    assert.deepEqual(await ids({ status: 'rejected' }), [rejected])
    for (const query of [{ status: 'done' }, { status: '' }, { limit: '0' }, { limit: '51' }, { cursor: '!!!' }]) {
      const res = await list(a.agent, query).expect(400)
      assert.match(res.body.error, /^invalid_(status|limit|cursor)$/, JSON.stringify(query))
    }
  })

  // limit 2로 끝까지 넘기며 쪽마다 id 목록
  const pagesOf = async (agent, query) => {
    const pages = []
    let cursor
    do {
      const body = (await list(agent, { ...query, limit: 2, ...(cursor ? { cursor } : {}) }).expect(200)).body
      pages.push(body.suggestions.map((s) => s.id))
      cursor = body.nextCursor
    } while (cursor)
    return pages
  }
  const at = (day) => ({ startAt: `2026-11-${day}T05:00:00Z`, endAt: `2026-11-${day}T06:00:00Z` })

  it('pending 정렬 · 커서: 시작 시각 빠른 순 → 같으면 id 순, 쪽 경계에 같은 시각이 걸려도 빠짐 · 겹침 없음', async () => {
    const ids = []
    for (const day of ['24', '21', '23', '21', '20']) {
      ids.push(await add(a, at(day)))
    }
    const [d24, d21a, d23, d21b, d20] = ids

    assert.deepEqual(await pagesOf(a.agent, {}), [[d20, d21a], [d21b, d23], [d24]])
  })

  it('pending 밖(accepted · rejected · expired) 정렬 · 커서: 최신순(id 내림차순), 시작 시각과 상관없음', async () => {
    const ids = []
    for (const day of ['24', '21', '23', '22', '20']) {
      ids.push(await add(a, { status: 'accepted', ...at(day) }))
    }

    assert.deepEqual(await pagesOf(a.agent, { status: 'accepted' }), [ids.slice(3).reverse(), ids.slice(1, 3).reverse(), [ids[0]]])
  })

  it('만료: 대기 중 시각 일정은 시작이 지나면, 하루 종일은 그날(서울)이 끝나면 pending에서 빠지고 expired로 보인다', async () => {
    const timed = await add(a, { startAt: '2026-11-13T00:30:00Z', endAt: '2026-11-13T01:30:00Z' })
    const allDay = await add(a, { startAt: '2026-11-12T15:00:00Z', endAt: '2026-11-13T15:00:00Z', isAllDay: true })
    const ids = async (status) => (await list(a.agent, { status }).expect(200)).body.suggestions.map((s) => [s.id, s.status])

    assert.deepEqual(await ids('pending'), [[allDay, 'pending'], [timed, 'pending']])
    built.clock.advance(30 * MINUTE_MS)
    assert.deepEqual(await ids('pending'), [[allDay, 'pending']], '시작 시각(00:30Z)이 되면 시각 일정은 만료')
    assert.deepEqual(await ids('expired'), [[timed, 'expired']])
    built.clock.advance(14 * 60 * MINUTE_MS + 29 * MINUTE_MS)
    assert.deepEqual(await ids('pending'), [[allDay, 'pending']], '서울 23:59까지는 하루 종일 대기')
    built.clock.advance(MINUTE_MS)
    assert.deepEqual(await ids('expired'), [[allDay, 'expired'], [timed, 'expired']])
  })

  it('수락: 201 { suggestion, schedule }, 기본값은 제안 내용 · 제목 "종류: 공지 제목", 앱 일정으로 events에 나온다', async () => {
    const id = await add(a, { kind: 'exam' })

    const res = await a.agent.post(acceptPath(id)).send({}).expect(201)

    assert.deepEqual([res.body.suggestion.status, res.body.suggestion.scheduleId], ['accepted', res.body.schedule.id])
    assert.deepEqual({ ...res.body.schedule, id: undefined }, {
      source: 'app', id: undefined, calendarLinkId: null, title: '시험: 중간고사 안내', ...FUTURE, isAllDay: false, startDate: null, endDate: null,
    })
    const events = (await a.agent.get('/api/calendar/events').query({ from: '2026-11-15T00:00:00Z', to: '2026-12-01T00:00:00Z' }).expect(200)).body.events
    assert.deepEqual(events.map((e) => [e.source, e.title]), [['app', '시험: 중간고사 안내']])
  })

  it('수락할 때 고친 값(제목 · 시각 · 하루 종일)으로 만들고, 검사는 앱 일정과 같다(틀리면 400 · 제안은 대기 그대로)', async () => {
    const id = await add(a)

    const bad = await a.agent.post(acceptPath(id)).send({ endAt: '2026-11-20T13:00:00+09:00' }).expect(400)
    assert.deepEqual([bad.body.error, bad.body.field], ['invalid_range', 'endAt'])
    assert.equal((await a.agent.post(acceptPath(id)).send({ isAllDay: true }).expect(400)).body.error, 'missing_start_at')
    assert.equal((await a.agent.post(acceptPath(id)).send({ title: '   ' }).expect(400)).body.error, 'missing_title')
    assert.deepEqual((await suggestionRows(ctx.pool, a.userId)).map((r) => [r.status, r.schedule_id]), [['pending', null]])

    const ok = await a.agent.post(acceptPath(id)).send({ title: '중간고사 (공학관)', endAt: '2026-11-20T16:00:00+09:00' }).expect(201)
    assert.deepEqual([ok.body.schedule.title, ok.body.schedule.startAt, ok.body.schedule.endAt], ['중간고사 (공학관)', FUTURE.startAt, '2026-11-20T07:00:00.000Z'])
  })

  it('거절: 204, 상태 rejected · 일정 없음', async () => {
    const id = await add(a)

    await a.agent.post(rejectPath(id)).expect(204)

    assert.deepEqual((await suggestionRows(ctx.pool, a.userId)).map((r) => [r.status, r.schedule_id, r.decided_at instanceof Date]), [['rejected', null, true]])
  })

  it('다른 사용자 제안 · 없는 id · 형식이 틀린 id → 수락 · 거절 모두 404 suggestion_not_found, 남의 제안은 그대로', async () => {
    const theirs = await add(b)

    for (const id of [theirs, theirs + 1000, 'abc', '0', '-1']) {
      assert.equal((await a.agent.post(acceptPath(id)).send({}).expect(404)).body.error, 'suggestion_not_found', String(id))
      await a.agent.post(rejectPath(id)).expect(404)
    }
    assert.deepEqual((await suggestionRows(ctx.pool, b.userId)).map((r) => r.status), ['pending'])
  })

  it('이미 처리한 제안: 수락한 것 다시 수락 · 거절, 거절한 것 수락 → 409 suggestion_already_decided (일정은 하나)', async () => {
    const id = await add(a)
    await a.agent.post(acceptPath(id)).send({}).expect(201)

    assert.equal((await a.agent.post(acceptPath(id)).send({}).expect(409)).body.error, 'suggestion_already_decided')
    assert.equal((await a.agent.post(rejectPath(id)).expect(409)).body.error, 'suggestion_already_decided')
    const other = await add(a, { startAt: '2026-11-21T05:00:00Z', endAt: '2026-11-21T06:00:00Z' })
    await a.agent.post(rejectPath(other)).expect(204)
    assert.equal((await a.agent.post(acceptPath(other)).send({}).expect(409)).body.error, 'suggestion_already_decided')
    const [[{ n }]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM schedules WHERE user_id = ?', [a.userId])
    assert.equal(Number(n), 1)
  })

  it('만료된 제안: 수락은 409 suggestion_expired(일정 안 만듦), 거절은 204', async () => {
    const timed = await add(a, { startAt: '2026-11-12T05:00:00Z', endAt: '2026-11-12T06:00:00Z' })
    const another = await add(a, { startAt: '2026-11-12T07:00:00Z', endAt: '2026-11-12T08:00:00Z' })

    assert.equal((await a.agent.post(acceptPath(timed)).send({}).expect(409)).body.error, 'suggestion_expired')
    await a.agent.post(rejectPath(another)).expect(204)
    const [[{ n }]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM schedules WHERE user_id = ?', [a.userId])
    assert.equal(Number(n), 0)
  })

  it('같은 제안을 동시에 두 번 수락 → 하나만 201, 하나는 409, 앱 일정은 하나', async () => {
    const id = await add(a)

    const results = await Promise.all([a.agent.post(acceptPath(id)).send({}), a.agent.post(acceptPath(id)).send({})])

    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409])
    const [[{ n }]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM schedules WHERE user_id = ?', [a.userId])
    assert.equal(Number(n), 1)
  })

  it('수락해서 만든 일정을 지워도(앱 일정 삭제) 제안은 accepted로 남고 scheduleId는 null로 보인다, 다시 수락 안 됨', async () => {
    const id = await add(a)
    const { body } = await a.agent.post(acceptPath(id)).send({}).expect(201)

    await a.agent.delete(`/api/calendar/schedules/${body.schedule.id}`).expect(204)
    await a.agent.post(acceptPath(id)).send({}).expect(409)

    const [item] = (await list(a.agent, { status: 'accepted' }).expect(200)).body.suggestions
    assert.deepEqual([item.id, item.status, item.scheduleId], [id, 'accepted', null])
  })
})
