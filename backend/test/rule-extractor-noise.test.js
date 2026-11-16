import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuleExtractor } from '../src/suggestions/rule-extractor.js'
import { parseClassPeriods } from '../src/suggestions/class-periods.js'
import { htmlToText } from '../src/suggestions/announcement-text.js'
import { EXAMPLE_CLASS_PERIODS } from './helpers/suggestion-context.js'

const POSTED = new Date('2026-11-12T01:00:00Z')
const extractor = createRuleExtractor({ classPeriods: parseClassPeriods(EXAMPLE_CLASS_PERIODS) })
const dates = (text, title = '') => extractor.extract({ title, text, postedAt: POSTED }).map((c) => c.startAt.toISOString().slice(0, 16))

// 잘못 잡으면 안 되는 것 (ADR 0011): 전화번호 · 학년도 · 장 · 절 · 쪽 · 점수 · 버전 · 소수 · URL 안 숫자 · 과목 코드 · 없는 날짜
describe('규칙 추출기: 날짜가 아닌 숫자는 잡지 않는다 · 맥락', () => {
  const noise = [
    ['전화번호', '문의: 010-1234-5678, 02-123-4567'],
    ['학년도 · 학기', '2026학년도 2학기 수강 안내'],
    ['장 · 절 · 쪽', '교재 3장 5절, 12쪽~15쪽을 읽어 오세요'],
    ['점수', '과제 점수 5/10점, 만점 20/20점'],
    ['버전 · 소수', 'v1.2 버전으로 올려 주세요. 평균 3.5, 표준편차 11.2'],
    ['URL', '자료: https://canvas.example.ac.kr/courses/101/files/2026-11-20/view 와 www.example.com/11/20'],
    ['과목 코드', 'CSE2016, MATH-1101 분반 공지'],
    ['없는 날짜', '13월 40일, 2/30, 2026-02-30, 11월 31일'],
    ['시각만(날짜 없음)', '오후 2시에 연구실로 오세요'],
    ['숫자 목록', '1. 출석 2. 과제 3. 시험 범위는 1~5장'],
    ['비율 · 분수', '참여율 3/4 이상, 1/2 감점'],
  ]
  for (const [label, text] of noise) {
    it(`${label}: "${text.slice(0, 24)}…" → 없음`, () => {
      assert.deepEqual(dates(text), [])
    })
  }

  it('날짜가 아닌 숫자 옆의 진짜 날짜는 잡는다 (잡음 때문에 놓치지 않음)', () => {
    assert.deepEqual(dates('문의 010-1234-5678. 시험은 11월 20일 오후 2시, 범위는 3장 ~ 5장 (2026학년도 2학기)'), ['2026-11-20T05:00'])
  })

  it('맥락: 날짜가 든 구절을 최대 60자로, 날짜 글자를 포함하고 줄바꿈 없이', () => {
    const long = `${'가'.repeat(80)} 중간고사는 11월 20일 오후 2시에 공학관 301호에서 봅니다 ${'나'.repeat(80)}`
    const [candidate] = extractor.extract({ title: '', text: long, postedAt: POSTED })

    assert.ok([...candidate.context].length <= 60, `맥락 ${[...candidate.context].length}자`)
    assert.match(candidate.context, /11월 20일/)
    assert.ok(!candidate.context.includes('\n'))
  })

  it('HTML 본문은 텍스트로 바꾼 뒤 추출: 태그 · 엔티티 사이의 날짜도, 속성 안의 숫자는 아님', () => {
    const html = '<p>중간고사:&nbsp;<b>11월</b> 20일 <span style="color:red">오후 2시</span></p><a href="https://x.test/12/24">자료</a>'

    assert.deepEqual(dates(htmlToText(html)), ['2026-11-20T05:00'])
  })

  it('같은 입력이면 항상 같은 결과 (now · 서버 시간대에 기대지 않음)', () => {
    const text = '내일 퀴즈, 다음 주 수요일 오후 3시 보강, 12월 18일 기말고사'

    assert.deepEqual(dates(text), dates(text))
    assert.deepEqual(dates(text), ['2026-11-12T15:00', '2026-11-18T06:00', '2026-12-17T15:00'])
  })
})
