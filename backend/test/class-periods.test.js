import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { parseClassPeriods, loadClassPeriods, ClassPeriodsError } from '../src/suggestions/class-periods.js'
import { EXAMPLE_CLASS_PERIODS } from './helpers/suggestion-context.js'

const REPO_CONFIG = fileURLToPath(new URL('../config/class-periods.json', import.meta.url))
const period = (n, start, end) => ({ period: n, start, end })

// 교시 시간표 설정 (ADR 0011): 코드에 넣지 않고 설정 파일, 시작 때 검사. 비어 있으면 교시 표현은 날짜만(저장소 파일은 실제 16교시)
describe('교시 시간표 설정', () => {
  it('올바른 시간표 → 교시 번호로 찾을 수 있다 (시작 · 끝 HH:mm)', () => {
    const periods = parseClassPeriods(EXAMPLE_CLASS_PERIODS)

    assert.deepEqual(periods.get(3), { start: '11:00', end: '11:50' })
    assert.equal(periods.get(7), undefined)
    assert.equal(periods.size, 6)
  })

  it('빈 시간표도 올바르다 (size 0)', () => {
    assert.equal(parseClassPeriods({ periods: [] }).size, 0)
  })

  // 2026-11-19 바꿈: 저장소 파일에 학교 실제 시간표를 넣어 "비어 있다"가 성립하지 않음(pr-notes 08 테스트 변경 기록)
  it('저장소의 기본 설정 파일(backend/config/class-periods.json)은 16교시이고 형식 검사를 통과한다', async () => {
    const periods = await loadClassPeriods(REPO_CONFIG)

    assert.equal(periods.size, 16)
    assert.deepEqual([periods.get(1), periods.get(12), periods.get(13), periods.get(16)], [
      { start: '09:00', end: '09:50' },
      { start: '19:05', end: '19:55' },
      { start: '20:00', end: '20:45' },
      { start: '22:30', end: '23:15' },
    ])
  })

  it('틀린 모양은 ClassPeriodsError (어느 교시 · 무엇이 틀렸는지만)', () => {
    const cases = [
      null,
      [],
      { periods: 'x' },
      { periods: [period(2, '09:00', '09:50')] },
      { periods: [period(1, '09:00', '09:50'), period(3, '11:00', '11:50')] },
      { periods: [period(1, '9:00', '09:50')] },
      { periods: [period(1, '09:00', '24:10')] },
      { periods: [period(1, '09:50', '09:00')] },
      { periods: [period(1, '09:00', '09:00')] },
      { periods: [period(1, '09:00', '10:10'), period(2, '10:00', '10:50')] },
      { periods: [period(1, '09:00', '09:50'), period(1, '10:00', '10:50')] },
      { periods: [{ period: '1', start: '09:00', end: '09:50' }] },
    ]
    for (const raw of cases) {
      assert.throws(() => parseClassPeriods(raw), ClassPeriodsError, JSON.stringify(raw))
    }
  })

  it('파일이 없거나 JSON이 아니면 ClassPeriodsError', async () => {
    await assert.rejects(loadClassPeriods('/nonexistent/class-periods.json'), ClassPeriodsError)
    await assert.rejects(loadClassPeriods(fileURLToPath(import.meta.url)), ClassPeriodsError)
  })
})
