import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { parseClassPeriods, loadClassPeriods, ClassPeriodsError } from '../src/suggestions/class-periods.js'
import { EXAMPLE_CLASS_PERIODS } from './helpers/suggestion-context.js'

const REPO_CONFIG = fileURLToPath(new URL('../config/class-periods.json', import.meta.url))
const period = (n, start, end) => ({ period: n, start, end })

// 교시 시간표 설정 (ADR 0011): 코드에 넣지 않고 설정 파일, 시작 때 검사. 비어 있으면 교시 표현은 날짜만
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

  it('저장소의 기본 설정 파일(backend/config/class-periods.json)은 읽히고 비어 있다', async () => {
    assert.equal((await loadClassPeriods(REPO_CONFIG)).size, 0)
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
