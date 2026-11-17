import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAnnouncement } from './helpers/fake-canvas.js'
import { connectUser, DAY_MS, TOKEN_A } from './helpers/lms-context.js'
import { buildSuggestionApp, suggestionRows, SUGGESTIONS_PATH, acceptPath, rejectPath, EXAMPLE_CLASS_PERIODS } from './helpers/suggestion-context.js'
import { createRuleExtractor } from '../src/suggestions/rule-extractor.js'
import { parseClassPeriods } from '../src/suggestions/class-periods.js'

const BODY_MARKER = 'BODY-MARKER-NOT-IN-LOGS'
const CONTEXT_MARKER = 'CTX-MARKER-NOT-IN-LOGS'
const TITLE_MARKER = 'TITLE-MARKER-NOT-IN-LOGS'

// 공지 본문 · 맥락 문장 · 공지 제목은 로그에 남기지 않는다 (ADR 0011). 동기화 로그에는 개수만
describe('제안 로그: 공지 본문 · 맥락 · 제목 없음', () => {
  let ctx

  before(async () => {
    ctx = await openTestContext()
    await ctx.resetDatabase()
  })
  after(async () => {
    await ctx.close()
  })

  it('추출 · 제안 저장 · 목록 · 수락 · 거절 · 추출 실패 전 과정의 로그(trace까지)에 본문 · 맥락 · 제목이 없다', async () => {
    const lines = []
    const canvas = createFakeCanvas()
    const real = createRuleExtractor({ classPeriods: parseClassPeriods(EXAMPLE_CLASS_PERIODS) })
    let fail = false
    // 실패할 때 에러 메시지에 본문 표식을 넣는다: 로그에 메시지를 남기면 걸린다
    const extractor = {
      extract: (input) => {
        if (fail) throw new Error(`extract failed ${BODY_MARKER}`)
        return real.extract(input)
      },
    }
    const built = buildSuggestionApp(ctx, { canvas, extractor, logger: pino({ level: 'trace' }, { write: (line) => lines.push(line) }) })
    const posted = new Date(built.clock.now().getTime() - DAY_MS).toISOString()
    canvas.addAccount(TOKEN_A, { id: 9001 })
    canvas.setCourses(TOKEN_A, [canvasCourse(101)])
    canvas.setAnnouncements(TOKEN_A, 101, [
      canvasAnnouncement(101, 701, { title: `시험 ${TITLE_MARKER}`, message: `<p>${BODY_MARKER}</p><p>${CONTEXT_MARKER} 11월 20일 오후 2시 시험</p><p>11월 21일 퀴즈</p>`, postedAt: posted }),
    ])
    const a = await connectUser(built, { email: 'a@example.com', token: TOKEN_A })
    const [first, second] = await suggestionRows(ctx.pool, a.userId)
    assert.ok(first && second, '전제: 제안이 실제로 만들어졌다')
    await a.agent.get(SUGGESTIONS_PATH).expect(200)
    await a.agent.post(acceptPath(first.id)).send({}).expect(201)
    await a.agent.post(rejectPath(second.id)).expect(204)
    fail = true
    canvas.setAnnouncements(TOKEN_A, 101, [
      canvasAnnouncement(101, 701, { title: `시험 ${TITLE_MARKER}`, message: `<p>${BODY_MARKER} 바뀜</p><p>${CONTEXT_MARKER} 11월 27일 시험</p>`, postedAt: posted }),
    ])
    assert.equal((await built.lms.lmsSync.syncUser(a.userId)).outcome, 'applied')
    assert.ok(lines.some((l) => l.includes('suggestion') && l.includes('failed')), '전제: 추출 실패가 로그에 남았다')

    assert.ok(lines.some((l) => l.includes('suggestion')), '전제: 제안 단계 로그가 실제로 남았다')
    const text = lines.join('\n')
    for (const secret of [BODY_MARKER, CONTEXT_MARKER, TITLE_MARKER, '11월 20일 오후 2시']) {
      assert.ok(!text.includes(secret), `로그에 있으면 안 됨: ${secret.slice(0, 8)}…`)
    }
  })
})
