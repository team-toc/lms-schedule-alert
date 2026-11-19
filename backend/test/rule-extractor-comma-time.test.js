import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRuleExtractor } from '../src/suggestions/rule-extractor.js'
import { loadClassPeriods } from '../src/suggestions/class-periods.js'

const REPO_CONFIG = fileURLToPath(new URL('../config/class-periods.json', import.meta.url))
const POSTED = new Date('2026-11-12T01:00:00Z')
// 서울 시각 'MM-DD HH:mm'으로 비교(TZ=UTC에서도 같은 값)
const kst = (date) => new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(5, 16).replace('T', ' ')

// 실제 공지 평가에서 나온 규칙 다듬기 (ADR 0011, 2026-11-19). 문장은 실제 공지가 아니라 같은 모양으로 새로 만든 예시
describe('규칙 추출기: 쉼표 뒤 시각 · 시험 평가 낱말', async () => {
  const extractor = createRuleExtractor({ classPeriods: await loadClassPeriods(REPO_CONFIG) })
  const run = (text, title = '') => extractor.extract({ title, text, postedAt: POSTED }).map((c) => [c.kind, kst(c.startAt), kst(c.endAt), c.isAllDay])
  const contextOf = (text) => extractor.extract({ title: '', text, postedAt: POSTED })[0].context

  it('같은 줄 날짜 뒤 쉼표 다음에 오는 시각은 그 날짜에 묶는다 (맥락도 시각까지)', () => {
    assert.deepEqual(run('시험일: 11월 20일, 오후 3시'), [['exam', '11-20 15:00', '11-20 16:00', false]])
    assert.deepEqual(run('11월 20일 , 14:00~15:30 시험'), [['exam', '11-20 14:00', '11-20 15:30', false]])
    assert.match(contextOf('시험일: 11월 20일, 오후 3시'), /11월 20일, 오후 3시/)
  })

  it('시와 분 사이 공백이 없어도(3시20분) 시각이다 — 오전 · 오후 없는 1 ~ 7시는 오후', () => {
    assert.deepEqual(run('11월 20일, 3시20분 시험'), [['exam', '11-20 15:20', '11-20 16:20', false]])
  })

  it('ISO 날짜 뒤에 "일"이 붙어도(2026-11-20일) 날짜, 쉼표 뒤 시각 + 교시: 명시 시각이 시작, 끝은 그 교시 끝', () => {
    assert.deepEqual(run('2026-11-20일 시험'), [['exam', '11-20 00:00', '11-21 00:00', true]])
    // 6교시 = 13:35 ~ 14:25 → 시작 13:50(명시), 끝 14:25(교시 끝)
    assert.deepEqual(run('2. 일시: 2026-11-20일 , 1시50분(6교시)', '중간고사 안내'), [['exam', '11-20 13:50', '11-20 14:25', false]])
    assert.match(contextOf('2. 일시: 2026-11-20일 , 1시50분(6교시)'), /1시50분/)
  })

  it('명시 시각이 교시 끝보다 늦으면(3시, 6교시는 14:25에 끝남) 끝은 기본 1시간', () => {
    assert.deepEqual(run('11월 20일, 3시(6교시) 시험'), [['exam', '11-20 15:00', '11-20 16:00', false]])
  })

  it('한 줄에 날짜가 둘이면 시각은 가까운(뒤따르는) 날짜에만: "11/19 휴강, 11/26 보강 14:00"', () => {
    assert.deepEqual(run('11/19 휴강, 11/26 보강 14:00'), [
      ['cancellation', '11-19 00:00', '11-20 00:00', true],
      ['makeup', '11-26 14:00', '11-26 15:00', false],
    ])
    assert.deepEqual(run('휴강: 11월 20일, 11월 21일 오후 2시 보강'), [
      ['cancellation', '11-20 00:00', '11-21 00:00', true],
      ['makeup', '11-21 14:00', '11-21 15:00', false],
    ])
    // 쉼표 뒤 시각을 묶어도 다음 날짜 앞에서 끊는다: 시각은 앞 날짜, 맥락에 뒤 날짜 구절이 섞이지 않음
    assert.deepEqual(run('휴강: 11월 20일, 오후 2시 11월 27일 보강'), [
      ['cancellation', '11-20 14:00', '11-20 15:00', false],
      ['makeup', '11-27 00:00', '11-28 00:00', true],
    ])
    assert.doesNotMatch(contextOf('휴강: 11월 20일, 오후 2시 11월 27일 보강'), /11월 27일/)
  })

  // 묶지 않는 쉼표는 지금처럼 구절 경계: 쉼표 뒤의 종류 낱말도 앞 날짜에 붙지 않는다(묶일 때만 그 구절 전체가 붙음)
  it('쉼표 뒤가 시각으로 시작하지 않으면 묶지 않고(쉼표 뒤 낱말도 안 붙음), 쉼표 두 번 건너서는 묶지 않는다', () => {
    assert.deepEqual(run('시험: 11월 20일, 공학관 301호'), [['exam', '11-20 00:00', '11-21 00:00', true]])
    assert.deepEqual(run('11월 20일, 공학관 301호 시험'), [['other', '11-20 00:00', '11-21 00:00', true]])
    assert.deepEqual(run('시험: 11월 20일, 공학관, 오후 2시'), [['exam', '11-20 00:00', '11-21 00:00', true]])
  })

  it('시험 낱말: 중간평가 · 기말평가 · 수시평가 · 실기평가는 시험, "평가" 한 낱말 · "강의평가"는 기타', () => {
    const kinds = ['중간평가', '기말평가', '수시평가', '실기평가', '평가', '강의평가'].map((word) => run(`11월 20일 ${word}`)[0][0])
    assert.deepEqual(kinds, ['exam', 'exam', 'exam', 'exam', 'other', 'other'])
    assert.equal(run('강의평가 기간 안내: 11월 20일까지')[0][0], 'other')
    assert.equal(run('11월 20일까지 강의평가', '강의평가 안내')[0][0], 'other')
  })
})
