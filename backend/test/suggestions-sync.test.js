import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAnnouncement } from './helpers/fake-canvas.js'
import { connectUser, DAY_MS, TOKEN_A, TOKEN_B } from './helpers/lms-context.js'
import { buildSuggestionApp, suggestionRows, suggestionSummary, countRows } from './helpers/suggestion-context.js'
import { createRuleExtractor } from '../src/suggestions/rule-extractor.js'
import { parseClassPeriods } from '../src/suggestions/class-periods.js'

const EXAM_BODY = '<p>중간고사는 <b>11월 20일 오후 2시</b> 공학관 301호에서 봅니다.</p><p>문의: 010-1234-5678</p>'
const EXAM = ['exam', '2026-11-20T05:00:00.000Z', '2026-11-20T06:00:00.000Z', false, 'pending']

// 수락 · 거절은 6단계 API 대신 행을 직접 바꾼다(이 파일은 동기화 쪽만 본다). 수락은 앱 일정 행도 만든다
async function decide(pool, row, status) {
  let scheduleId = null
  if (status === 'accepted') {
    const [schedule] = await pool.execute("INSERT INTO schedules (user_id, source, title, start_at, end_at) VALUES (?, 'app', '시험: 중간고사 안내', ?, ?)", [row.user_id, row.start_at, row.end_at])
    scheduleId = schedule.insertId
  }
  await pool.execute('UPDATE suggestions SET status = ?, schedule_id = ?, decided_at = NOW(3) WHERE id = ?', [status, scheduleId, row.id])
  return scheduleId
}

// 공지 → 제안 (ADR 0011): Canvas 반영 뒤 별도 단계, 사용자별, 멱등, 공지 수정 정책, 추출 실패는 동기화를 실패시키지 않음
describe('공지 일정 제안: 동기화 연동', () => {
  let ctx
  let canvas
  let built
  let posted
  let impl
  let extractCalls
  let a
  const realExtractor = createRuleExtractor({ classPeriods: parseClassPeriods({ periods: [] }) })
  const announce = (message, { id = 701, title = '중간고사 안내', token = TOKEN_A } = {}) => canvas.setAnnouncements(token, 101, [canvasAnnouncement(101, id, { title, message, postedAt: posted })])
  const sync = (userId = a.userId) => built.lms.lmsSync.syncUser(userId)

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    impl = realExtractor
    canvas = createFakeCanvas()
    // 추출기를 테스트 중에 바꿔 끼울 수 있게 감싼다
    extractCalls = 0
    built = buildSuggestionApp(ctx, {
      canvas,
      extractor: {
        extract: (input) => {
          extractCalls += 1
          return impl.extract(input)
        },
      },
    })
    posted = new Date(built.clock.now().getTime() - DAY_MS).toISOString()
    for (const [token, id] of [
      [TOKEN_A, 9001],
      [TOKEN_B, 9002],
    ]) {
      canvas.addAccount(token, { id })
      canvas.setCourses(token, [canvasCourse(101, { name: '자료구조' })])
      announce(EXAM_BODY, { token })
    }
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
  })
  after(async () => {
    await ctx.close()
  })

  it('첫 연동(기준 동기화)에서도 다가오는 날짜는 제안한다: 공지 하나 → 대기 제안 하나, 맥락은 60자 이내 · 날짜 포함', async () => {
    const [row] = await suggestionRows(ctx.pool, a.userId)

    assert.deepEqual(await suggestionSummary(ctx.pool, a.userId), [EXAM])
    assert.ok([...row.context].length <= 60)
    assert.match(row.context, /11월 20일 오후 2시/)
    assert.ok(!row.context.includes('010-1234-5678'), '다른 문단(전화번호)은 맥락에 없음')
    assert.equal(await countRows(ctx.pool, 'announcement_scans', a.userId), 1)
  })

  it('변화 없는 재동기화 → 추가 0건, 행 그대로(updated_at 포함), 추출기도 다시 부르지 않는다', async () => {
    const before = await suggestionRows(ctx.pool, a.userId)
    built.clock.advance(60 * 1000)
    extractCalls = 0

    await sync()
    await sync()

    assert.deepEqual(await suggestionRows(ctx.pool, a.userId), before)
    // 5단계에서 더함(백업에 없던 단언): 훑은 기록의 내용 해시가 같으면 다시 추출하지 않는다
    assert.equal(extractCalls, 0)
  })

  it('공지 수정으로 날짜가 바뀌면 대기 제안을 새 결과로 바꾼다 (옛 날짜 대기 제안은 지움)', async () => {
    announce('<p>중간고사는 11월 27일 오후 2시로 바뀌었습니다.</p>')

    await sync()

    assert.deepEqual(await suggestionSummary(ctx.pool, a.userId), [['exam', '2026-11-27T05:00:00.000Z', '2026-11-27T06:00:00.000Z', false, 'pending']])
  })

  it('수락한 제안과 만든 일정은 공지가 바뀌어도 그대로, 새 날짜는 새 대기 제안으로', async () => {
    const [row] = await suggestionRows(ctx.pool, a.userId)
    const scheduleId = await decide(ctx.pool, row, 'accepted')
    announce('<p>중간고사는 11월 27일 오후 2시로 바뀌었습니다.</p>')

    await sync()

    assert.deepEqual(await suggestionSummary(ctx.pool, a.userId), [
      ['exam', '2026-11-20T05:00:00.000Z', '2026-11-20T06:00:00.000Z', false, 'accepted'],
      ['exam', '2026-11-27T05:00:00.000Z', '2026-11-27T06:00:00.000Z', false, 'pending'],
    ])
    const [[schedule]] = await ctx.pool.query('SELECT start_at, deleted_at FROM schedules WHERE id = ?', [scheduleId])
    assert.deepEqual([schedule.start_at.toISOString(), schedule.deleted_at], ['2026-11-20T05:00:00.000Z', null], '만든 일정은 건드리지 않음')
  })

  it('거절한 제안은 공지가 (같은 날짜로) 수정돼도 다시 묻지 않는다', async () => {
    const [row] = await suggestionRows(ctx.pool, a.userId)
    await decide(ctx.pool, row, 'rejected')
    announce('<p>중간고사는 11월 20일 오후 2시 공학관 302호로 장소가 바뀌었습니다.</p>')

    await sync()

    assert.deepEqual((await suggestionSummary(ctx.pool, a.userId)).map((r) => r[4]), ['rejected'])

    // 5단계에서 더함(백업에 없던 단언): 같은 시각이 다른 종류로 바뀌어도 처리한 제안은 종류 · 맥락 그대로
    const [decided] = await suggestionRows(ctx.pool, a.userId)
    announce('<p>보강은 11월 20일 오후 2시에 합니다.</p>', { title: '보강 안내' })
    await sync()
    const [after] = await suggestionRows(ctx.pool, a.userId)
    assert.deepEqual([after.id, after.kind, after.context, after.status], [decided.id, 'exam', decided.context, 'rejected'])
  })

  it('같은 시각이 다른 종류로 분류되면(시험 → 보강) 새 제안이 아니라 대기 제안의 종류만 바뀐다', async () => {
    const [before] = await suggestionRows(ctx.pool, a.userId)
    announce('<p>보강은 11월 20일 오후 2시에 합니다.</p>', { title: '보강 안내' })

    await sync()

    const rows = await suggestionRows(ctx.pool, a.userId)
    assert.deepEqual(rows.map((r) => [r.id, r.kind]), [[before.id, 'makeup']])
  })

  it('지난 날짜는 제안하지 않고, 같은 날짜 · 시각은 하나, 공지 하나당 5개까지(본문 앞쪽부터)', async () => {
    const lines = ['이번 주 월요일 보강', '11월 20일 오후 2시 퀴즈', '11월 20일 오후 2시 퀴즈', ...[21, 22, 23, 24, 25, 26].map((d) => `11월 ${d}일 퀴즈`)]
    announce(lines.map((l) => `<p>${l}</p>`).join(''))

    await sync()

    const rows = await suggestionRows(ctx.pool, a.userId)
    // 11-20 14:00(중복 둘은 하나, 처음부터 있던 제안 그대로) → 하루 종일 11-21 · 22 · 23 · 24 (서울 자정 = 전날 15:00Z). 11-25 · 26은 상한 밖
    assert.deepEqual(rows.map((r) => r.start_at.toISOString()), [
      '2026-11-20T05:00:00.000Z', '2026-11-20T15:00:00.000Z', '2026-11-21T15:00:00.000Z', '2026-11-22T15:00:00.000Z', '2026-11-23T15:00:00.000Z',
    ])
    assert.ok(!rows.some((r) => r.start_at.toISOString() === '2026-11-08T15:00:00.000Z'), '지난 이번 주 월요일(11-09) 없음')
  })

  // 4단계 리뷰에서 더함 (백업 브랜치에 없던 테스트): 시작이 지났어도 끝이 미래인 하루 종일 범위는 제안한다
  it('진행 중인 날짜 범위(시작은 지났고 끝은 미래)는 제안, 끝까지 지난 범위 · 지난 날 하루는 제안 안 함', async () => {
    // 시계: 11-13 09:00 KST
    announce('<p>11월 12일 ~ 11월 14일 휴강</p><p>11월 10일 ~ 11월 12일 휴강</p><p>11월 12일 휴강</p>', { title: '휴강 안내' })

    await sync()

    assert.deepEqual(await suggestionSummary(ctx.pool, a.userId), [['cancellation', '2026-11-11T15:00:00.000Z', '2026-11-14T15:00:00.000Z', true, 'pending']])
  })

  // 5단계 리뷰에서 더함 (백업 브랜치에 없던 테스트): 제목은 본문 앞 한 줄로 같은 추출기에
  it('공지 제목의 날짜도 제안: 제목에만 → 1개(맥락은 제목), 제목 · 본문에 같은 날짜 → 1개, 다른 날짜 → 2개', async () => {
    const rows = async () => (await suggestionRows(ctx.pool, a.userId)).map((r) => [r.kind, r.start_at.toISOString(), r.is_all_day ? 1 : 0, r.context])
    const nov20 = ['cancellation', '2026-11-19T15:00:00.000Z', 1]

    announce('<p>교수님 사정으로 수업이 없습니다.</p>', { title: '[휴강] 11/20(금) 3교시 휴강' })
    await sync()
    assert.deepEqual(await rows(), [[...nov20, '[휴강] 11/20(금) 3교시 휴강']], '제목에만 날짜')

    announce('<p>11월 20일은 휴강합니다.</p>', { title: '[휴강] 11/20(금) 휴강' })
    await sync()
    assert.equal((await rows()).length, 1, '제목 · 본문의 같은 날짜는 하나')

    announce('<p>보강은 11월 27일입니다.</p>', { title: '[휴강] 11/20(금) 휴강' })
    await sync()
    assert.deepEqual(await rows(), [
      [...nov20, '[휴강] 11/20(금) 휴강'],
      ['makeup', '2026-11-26T15:00:00.000Z', 1, '보강은 11월 27일입니다'],
    ], '다른 날짜는 둘')
  })

  // 5단계 리뷰에서 더함 (백업 브랜치에 없던 테스트): 지우는 기준은 Canvas 응답이 아니라 user_announcements 연결
  it('30일 창 밖으로 밀린 공지(연결 유지)의 미래 대기 제안은 남고, 연결이 끊긴 공지의 대기 제안은 지운다', async () => {
    const old = new Date(built.clock.now().getTime() - 25 * DAY_MS).toISOString()
    canvas.setAnnouncements(TOKEN_A, 101, [
      canvasAnnouncement(101, 701, { title: '중간고사 안내', message: EXAM_BODY, postedAt: posted }),
      canvasAnnouncement(101, 704, { title: '기말고사 안내', message: '<p>기말고사는 12월 15일입니다.</p>', postedAt: old }),
    ])
    await sync()
    const finals = (await suggestionRows(ctx.pool, a.userId)).find((r) => r.announcement_canvas_id === 704)
    assert.ok(finals, '전제: 기말고사 제안이 생겼다')

    // 10일 뒤: 704는 35일 전 게시라 Canvas 응답(30일 창)에 없다. 701은 창 안에서 목록에서 빠짐 → 연결 끊김
    built.clock.advance(10 * DAY_MS)
    canvas.setAnnouncements(TOKEN_A, 101, [])
    assert.equal((await sync()).outcome, 'applied')

    const left = await suggestionRows(ctx.pool, a.userId)
    assert.deepEqual(left.map((r) => [r.id, r.announcement_canvas_id, r.status]), [[finals.id, 704, 'pending']])
    const [[link]] = await ctx.pool.query('SELECT COUNT(*) AS n FROM user_announcements WHERE user_id = ? AND announcement_id = ?', [a.userId, finals.announcement_id])
    assert.equal(Number(link.n), 1, '창 밖 공지는 연결 유지')
  })

  it('추출기가 던져도 동기화는 applied(Canvas 반영됨) · 제안 없음 · 훑은 기록 없음, 고친 뒤 다음 동기화에서 제안이 생긴다', async () => {
    // 5단계에서 고침(백업과 다름): 같은 동기화의 다른 공지(703)는 제안이 생겨야 한다 — 실패는 그 공지만
    canvas.setAnnouncements(TOKEN_A, 101, [
      canvasAnnouncement(101, 702, { title: '기말고사 안내', message: '<p>기말고사는 12월 18일 오후 2시</p>', postedAt: posted }),
      canvasAnnouncement(101, 703, { title: '퀴즈 안내', message: '<p>11월 25일 퀴즈</p>', postedAt: posted }),
    ])
    impl = {
      extract: (input) => {
        if (input.title === '기말고사 안내') {
          throw new Error('extractor exploded')
        }
        return realExtractor.extract(input)
      },
    }

    assert.equal((await sync()).outcome, 'applied')
    assert.ok((await suggestionRows(ctx.pool, a.userId)).some((r) => r.announcement_canvas_id === 703), '실패하지 않은 공지는 같은 동기화에서 제안됨')
    const [[{ n }]] = await ctx.pool.query("SELECT COUNT(*) AS n FROM announcements WHERE canvas_id = 702")
    assert.equal(Number(n), 1, 'Canvas 공지는 반영됨')
    assert.ok(!(await suggestionRows(ctx.pool, a.userId)).some((r) => r.announcement_canvas_id === 702))

    impl = realExtractor
    await sync()
    assert.ok((await suggestionRows(ctx.pool, a.userId)).some((r) => r.announcement_canvas_id === 702))
  })

  it('같은 공지를 보는 다른 사용자도 자기 제안을 따로 받고, 서로 섞이지 않는다', async () => {
    const b = await connectUser(built, { email: 'b@example.com', token: TOKEN_B })
    const [mine] = await suggestionRows(ctx.pool, a.userId)
    await decide(ctx.pool, mine, 'rejected')

    assert.deepEqual(await suggestionSummary(ctx.pool, b.userId), [EXAM], 'A가 거절해도 B는 대기')
    assert.equal(await countRows(ctx.pool, 'suggestions', a.userId), 1)
  })

  it('내 목록에서 사라진 공지의 대기 제안은 지우고, 수락한 제안은 남긴다', async () => {
    canvas.setAnnouncements(TOKEN_A, 101, [
      canvasAnnouncement(101, 701, { title: '중간고사 안내', message: EXAM_BODY, postedAt: posted }),
      canvasAnnouncement(101, 703, { title: '퀴즈 안내', message: '<p>11월 25일 퀴즈</p>', postedAt: posted }),
    ])
    await sync()
    const quiz = (await suggestionRows(ctx.pool, a.userId)).find((r) => r.announcement_canvas_id === 703)
    await decide(ctx.pool, quiz, 'accepted')
    canvas.setAnnouncements(TOKEN_A, 101, [])

    await sync()

    assert.deepEqual((await suggestionRows(ctx.pool, a.userId)).map((r) => [r.announcement_canvas_id, r.status]), [[703, 'accepted']])
  })
})
