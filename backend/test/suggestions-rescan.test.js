import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAnnouncement } from './helpers/fake-canvas.js'
import { connectUser, DAY_MS, TOKEN_A } from './helpers/lms-context.js'
import { buildSuggestionApp, suggestionRows, suggestionSummary, EXAMPLE_CLASS_PERIODS } from './helpers/suggestion-context.js'
import { createRuleExtractor, EXTRACTOR_RULES_VERSION } from '../src/suggestions/rule-extractor.js'
import { parseClassPeriods } from '../src/suggestions/class-periods.js'

const ALL_DAY_20 = ['exam', '2026-11-19T15:00:00.000Z', '2026-11-20T15:00:00.000Z', true]
// EXAMPLE_CLASS_PERIODS 3교시 = 11:00 ~ 11:50 KST
const TIMED_20 = ['exam', '2026-11-20T02:00:00.000Z', '2026-11-20T02:50:00.000Z', false]

// 수락은 API 대신 행을 직접 바꾼다(suggestions-sync.test.js와 같은 방식). 앱 일정 행도 만든다
async function accept(pool, row) {
  const [schedule] = await pool.execute("INSERT INTO schedules (user_id, source, title, start_at, end_at, is_all_day) VALUES (?, 'app', '시험: 퀴즈 안내', ?, ?, 1)", [row.user_id, row.start_at, row.end_at])
  await pool.execute("UPDATE suggestions SET status = 'accepted', schedule_id = ?, decided_at = NOW(3) WHERE id = ?", [schedule.insertId, row.id])
  return schedule.insertId
}

// 추출기 버전(규칙 버전 상수 + 교시 시간표 내용)이 바뀌면 이미 훑은 공지도 다음 동기화에서 한 번 다시 분석 (ADR 0011, 2026-11-19).
// 다시 분석해도 정책은 같다: 대기 제안만 바뀌고 수락 · 거절한 제안과 만든 일정은 그대로
describe('공지 일정 제안: 추출기 버전이 바뀌면 다시 분석', () => {
  let ctx
  let canvas
  let built
  let impl
  let calls
  let a
  const withoutPeriods = createRuleExtractor({ classPeriods: parseClassPeriods({ periods: [] }) })
  const withPeriods = createRuleExtractor({ classPeriods: parseClassPeriods(EXAMPLE_CLASS_PERIODS) })
  const sync = () => built.lms.lmsSync.syncUser(a.userId)

  before(async () => {
    ctx = await openTestContext()
  })
  beforeEach(async () => {
    await ctx.resetDatabase()
    impl = withoutPeriods
    calls = 0
    canvas = createFakeCanvas()
    // 바꿔 끼울 수 있는 추출기: 버전도 그때그때의 것(제안 단계는 동기화마다 버전을 읽는다)
    const extractor = {
      extract: (input) => {
        calls += 1
        return impl.extract(input)
      },
      get version() {
        return impl.version
      },
    }
    built = buildSuggestionApp(ctx, { canvas, extractor })
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101, { name: '자료구조' })])
    const posted = new Date(built.clock.now().getTime() - DAY_MS).toISOString()
    canvas.setAnnouncements(TOKEN_A, 101, [canvasAnnouncement(101, 701, { title: '퀴즈 안내', message: '<p>11월 20일 3교시 퀴즈</p>', postedAt: posted })])
    a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
  })
  after(async () => {
    await ctx.close()
  })

  it('버전 문자열: 규칙 버전 상수 + 교시 시간표 내용. 같은 시간표면 같고, 시간표가 다르면 다르다', () => {
    assert.ok(Number.isInteger(EXTRACTOR_RULES_VERSION) && EXTRACTOR_RULES_VERSION >= 1)
    assert.match(withPeriods.version, new RegExp(`^rules:${EXTRACTOR_RULES_VERSION}\\|periods:[0-9a-f]+$`))
    assert.equal(createRuleExtractor({ classPeriods: parseClassPeriods(EXAMPLE_CLASS_PERIODS) }).version, withPeriods.version)
    assert.notEqual(withoutPeriods.version, withPeriods.version)
  })

  it('버전이 그대로면 변화 없는 재동기화에서 다시 분석 0번', async () => {
    assert.deepEqual(await suggestionSummary(ctx.pool, a.userId), [[...ALL_DAY_20, 'pending']])
    calls = 0

    await sync()
    await sync()

    assert.equal(calls, 0)
  })

  it('버전이 바뀌면(교시 시간표 추가) 기존 공지를 한 번 다시 분석: 하루 종일 대기 제안이 새 시각 제안으로 바뀌고, 그다음은 다시 0번', async () => {
    calls = 0
    impl = withPeriods

    await sync()

    assert.equal(calls, 1, '공지 하나를 다시 분석')
    assert.deepEqual(await suggestionSummary(ctx.pool, a.userId), [[...TIMED_20, 'pending']], '하루 종일 대기 제안은 지워지고 시각 제안')
    await sync()
    assert.equal(calls, 1, '새 버전으로 훑은 뒤에는 다시 0번')
  })

  it('다시 분석해도 수락한 제안과 만든 일정은 그대로, 새 시각은 새 대기 제안으로', async () => {
    const [row] = await suggestionRows(ctx.pool, a.userId)
    const scheduleId = await accept(ctx.pool, row)
    impl = withPeriods

    await sync()

    assert.deepEqual(await suggestionSummary(ctx.pool, a.userId), [
      [...ALL_DAY_20, 'accepted'],
      [...TIMED_20, 'pending'],
    ])
    const [[schedule]] = await ctx.pool.query('SELECT start_at, is_all_day, deleted_at FROM schedules WHERE id = ?', [scheduleId])
    assert.deepEqual([schedule.start_at.toISOString(), Boolean(schedule.is_all_day), schedule.deleted_at], [ALL_DAY_20[1], true, null], '만든 일정은 건드리지 않음')
  })
})
