import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRuleExtractor } from '../src/suggestions/rule-extractor.js'
import { loadClassPeriods } from '../src/suggestions/class-periods.js'

const REPO_CONFIG = fileURLToPath(new URL('../config/class-periods.json', import.meta.url))
// 게시 2026-11-12 10:00 KST. 시각은 모두 UTC(Z)로 비교한다: 서울 = UTC + 9시간
const POSTED = new Date('2026-11-12T01:00:00Z')
const DAY_START_UTC = '2026-11-19T15:00:00.000Z'
const DAY_END_UTC = '2026-11-20T15:00:00.000Z'

// 학교 실제 교시 시간표(저장소 config/class-periods.json을 그대로 읽어 주입, ADR 0011 · 2026-11-19)
// "N교시" · "N~M교시" → 시작은 앞 교시 시작, 끝은 뒤 교시 끝. 없는 교시 · 거꾸로 된 범위는 날짜만(하루 종일)
describe('규칙 추출기: 학교 실제 교시 시간표', async () => {
  const extractor = createRuleExtractor({ classPeriods: await loadClassPeriods(REPO_CONFIG) })
  const run = (text) => extractor.extract({ title: '', text, postedAt: POSTED }).map((c) => [c.startAt.toISOString(), c.endAt.toISOString(), c.isAllDay])

  it('3교시 → 10:50 ~ 11:40 KST (= 01:50Z ~ 02:40Z)', () => {
    assert.deepEqual(run('11월 20일 3교시 퀴즈'), [['2026-11-20T01:50:00.000Z', '2026-11-20T02:40:00.000Z', false]])
  })

  it('5~6교시 → 12:40 ~ 14:25 KST (시작은 앞 교시 시작, 끝은 뒤 교시 끝)', () => {
    assert.deepEqual(run('11월 20일 5~6교시 시험'), [['2026-11-20T03:40:00.000Z', '2026-11-20T05:25:00.000Z', false]])
  })

  it('16교시 → 22:30 ~ 23:15 KST (= 13:30Z ~ 14:15Z, 같은 서울 날짜)', () => {
    assert.deepEqual(run('11월 20일 16교시 보강'), [['2026-11-20T13:30:00.000Z', '2026-11-20T14:15:00.000Z', false]])
  })

  it('13~14교시 → 20:00 ~ 21:35 KST (45분 수업 구간)', () => {
    assert.deepEqual(run('11월 20일 13~14교시 시험'), [['2026-11-20T11:00:00.000Z', '2026-11-20T12:35:00.000Z', false]])
  })

  it('시간표에 없는 교시(17교시) → 시각 없이 날짜만', () => {
    assert.deepEqual(run('11월 20일 17교시 시험'), [[DAY_START_UTC, DAY_END_UTC, true]])
  })

  it('거꾸로 된 범위(9~3교시) → 시각 없이 날짜만', () => {
    assert.deepEqual(run('11월 20일 9~3교시 시험'), [[DAY_START_UTC, DAY_END_UTC, true]])
  })
})
