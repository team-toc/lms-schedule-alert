import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuleExtractor } from '../src/suggestions/rule-extractor.js'
import { parseClassPeriods } from '../src/suggestions/class-periods.js'
import { EXAMPLE_CLASS_PERIODS } from './helpers/suggestion-context.js'

// 게시 시각: 2026-11-12 10:00 KST(목요일). 상대 날짜 · 연도 없는 날짜의 기준은 이 날(서울)
const POSTED = new Date('2026-11-12T01:00:00Z')
const extractor = createRuleExtractor({ classPeriods: parseClassPeriods(EXAMPLE_CLASS_PERIODS) })
const noPeriods = createRuleExtractor({ classPeriods: parseClassPeriods({ periods: [] }) })

// [종류, 시작, 끝, 하루 종일]
const run = (text, { title = '', postedAt = POSTED, using = extractor } = {}) =>
  using.extract({ title, text, postedAt }).map((c) => [c.kind, c.startAt.toISOString(), c.endAt.toISOString(), c.isAllDay])
// 서울 날짜 하루 종일 = 전날 15:00Z ~ 그날 15:00Z
const allDay = (kind, date) => {
  const start = new Date(new Date(`${date}T00:00:00+09:00`).getTime())
  return [kind, start.toISOString(), new Date(start.getTime() + 86400000).toISOString(), true]
}
const timed = (kind, start, end) => [kind, new Date(start).toISOString(), new Date(end).toISOString(), false]

// 규칙 기반 추출기 (ADR 0011): 결정적 순수 함수(now를 모름), 시각은 서울로 해석해 UTC로
describe('규칙 추출기: 날짜 · 시간 · 상대 날짜 · 교시 · 종류', () => {
  it('날짜 형식: 11월 20일 · 11/20 · 2026.11.20 · 2026-11-20 · 2026.11.5 · 11.20(금), 시간이 없으면 하루 종일', () => {
    assert.deepEqual(run('중간고사는 11월 20일입니다.'), [allDay('exam', '2026-11-20')])
    assert.deepEqual(run('11/20 퀴즈'), [allDay('exam', '2026-11-20')])
    assert.deepEqual(run('2026.11.20 시험'), [allDay('exam', '2026-11-20')])
    assert.deepEqual(run('2026-11-20 시험'), [allDay('exam', '2026-11-20')])
    assert.deepEqual(run('2026.11.5 시험'), [allDay('exam', '2026-11-05')], '연도가 적혀 있으면 그 연도 그대로(지난 날짜인지는 추출기 밖에서)')
    assert.deepEqual(run('11.20(금) 퀴즈'), [allDay('exam', '2026-11-20')])
    assert.deepEqual(run('11월 20일(금) 퀴즈'), [allDay('exam', '2026-11-20')])
  })

  it('시간: 오후 2시 · 14:00 · 오전 10시 · 2시 30분(오전 · 오후 없는 1 ~ 7시는 오후), 끝이 없으면 1시간', () => {
    assert.deepEqual(run('11월 20일 오후 2시 시험'), [timed('exam', '2026-11-20T14:00:00+09:00', '2026-11-20T15:00:00+09:00')])
    assert.deepEqual(run('11월 20일 14:00 시험'), [timed('exam', '2026-11-20T14:00:00+09:00', '2026-11-20T15:00:00+09:00')])
    assert.deepEqual(run('11월 20일 오전 10시 시험'), [timed('exam', '2026-11-20T10:00:00+09:00', '2026-11-20T11:00:00+09:00')])
    assert.deepEqual(run('11월 20일 2시 30분 시험'), [timed('exam', '2026-11-20T14:30:00+09:00', '2026-11-20T15:30:00+09:00')])
    assert.deepEqual(run('11월 20일 오후 12시 시험'), [timed('exam', '2026-11-20T12:00:00+09:00', '2026-11-20T13:00:00+09:00')])
    assert.deepEqual(run('11월 20일 9시 시험'), [timed('exam', '2026-11-20T09:00:00+09:00', '2026-11-20T10:00:00+09:00')])
  })

  it('시간 범위: 14:00~16:00 · 오후 2시부터 4시까지 · 오후 2시~4시(끝도 오후) · 2시 30분 ~ 4시', () => {
    const expected = [timed('exam', '2026-11-20T14:00:00+09:00', '2026-11-20T16:00:00+09:00')]
    assert.deepEqual(run('11월 20일 14:00~16:00 시험'), expected)
    assert.deepEqual(run('11월 20일 14:00 - 16:00 시험'), expected)
    assert.deepEqual(run('11월 20일 오후 2시부터 4시까지 시험'), expected)
    assert.deepEqual(run('11월 20일 오후 2시~4시 시험'), expected)
    assert.deepEqual(run('11월 20일 2시 30분 ~ 4시 시험'), [timed('exam', '2026-11-20T14:30:00+09:00', '2026-11-20T16:00:00+09:00')])
  })

  // 3단계 리뷰에서 더함 (백업 브랜치에 없던 테스트)
  it('자정 마감: "밤 12시" · "자정" · "24:00" → 다음 날 00:00 시작, 범위 끝이 자정이어도 다음 날 00:00', () => {
    const midnight = [timed('deadline', '2026-11-21T00:00:00+09:00', '2026-11-21T01:00:00+09:00')]
    assert.deepEqual(run('11월 20일 밤 12시까지 과제 제출'), midnight)
    assert.deepEqual(run('11월 20일 자정까지 과제 제출'), midnight)
    assert.deepEqual(run('11월 20일 24:00 마감'), midnight)
    assert.deepEqual(run('11월 20일 22:00~24:00 시험'), [timed('exam', '2026-11-20T22:00:00+09:00', '2026-11-21T00:00:00+09:00')])
    assert.deepEqual(run('11월 20일 오후 10시~자정 시험'), [timed('exam', '2026-11-20T22:00:00+09:00', '2026-11-21T00:00:00+09:00')])
  })

  // 3단계 리뷰에서 더함 (백업 브랜치에 없던 테스트)
  it('때 낱말: 저녁 · 밤 → 오후, 아침 · 새벽 → 오전 (낱말이 없을 때의 1 ~ 7시 오후 규칙보다 앞선다), 오전 12시 = 00:00, 낮 12시 · 정오 = 12:00', () => {
    const at = (text, start, end) => assert.deepEqual(run(`11월 20일 ${text} 보강`), [timed('makeup', `2026-11-20T${start}:00+09:00`, `2026-11-20T${end}:00+09:00`)], text)
    at('저녁 7시', '19:00', '20:00')
    at('저녁 8시', '20:00', '21:00')
    at('밤 9시', '21:00', '22:00')
    at('아침 7시', '07:00', '08:00')
    at('새벽 2시', '02:00', '03:00')
    at('저녁 6시~8시', '18:00', '20:00')
    at('오전 12시', '00:00', '01:00')
    at('낮 12시', '12:00', '13:00')
    at('정오', '12:00', '13:00')
  })

  // 4단계 리뷰에서 더함 (백업 브랜치에 없던 테스트)
  it('시각이 날짜보다 앞에 오면 시각은 쓰지 않고 하루 종일', () => {
    assert.deepEqual(run('오후 2시, 11월 20일 시험'), [allDay('exam', '2026-11-20')])
    assert.deepEqual(run('14:00 11월 20일 시험'), [allDay('exam', '2026-11-20')])
  })

  // 4단계 리뷰에서 더함 (백업 브랜치에 없던 테스트)
  it('날짜 범위: ~ · - · 부터 ~까지로 이은 두 날짜는 하루 종일 하나(끝 날짜 포함), 14일 넘거나 끝이 앞이면 따로', () => {
    const range = (kind, from, to) => [kind, new Date(`${from}T00:00:00+09:00`).toISOString(), new Date(`${to}T00:00:00+09:00`).toISOString(), true]
    assert.deepEqual(run('11월 20일 ~ 11월 22일 휴강'), [range('cancellation', '2026-11-20', '2026-11-23')], '3일 → 하나')
    assert.deepEqual(run('11월 20일부터 11월 22일까지 휴강'), [range('cancellation', '2026-11-20', '2026-11-23')])
    assert.deepEqual(run('11/20(금)~11/22(일) 휴강'), [range('cancellation', '2026-11-20', '2026-11-23')])
    assert.deepEqual(run('2026-11-20 - 2026-11-22 휴강'), [range('cancellation', '2026-11-20', '2026-11-23')])
    assert.deepEqual(run('11월 20일 ~ 12월 3일 과제 제출'), [range('deadline', '2026-11-20', '2026-12-04')], '14일은 범위')
    assert.deepEqual(run('11월 20일 ~ 12월 4일 과제 제출'), [allDay('deadline', '2026-11-20'), allDay('deadline', '2026-12-04')], '15일 → 따로 2개')
    assert.deepEqual(run('11월 22일 ~ 11월 20일 휴강'), [allDay('cancellation', '2026-11-22'), allDay('cancellation', '2026-11-20')], '끝이 시작보다 앞 → 범위 아님')
    assert.deepEqual(run('11월 20일 ~ 11월 20일 휴강'), [allDay('cancellation', '2026-11-20'), allDay('cancellation', '2026-11-20')], '같은 날 → 범위 아님(중복은 제안 단계에서)')
    assert.deepEqual(run('12월 28일 ~ 1월 3일 휴강', { postedAt: new Date('2026-12-20T00:00:00Z') }), [range('cancellation', '2026-12-28', '2027-01-04')], '연도를 넘는 범위')
    assert.deepEqual(run('11월 20일, 11월 22일 휴강').length, 2, '쉼표는 범위 표시가 아님')
  })

  it('상대 날짜(게시일 서울 기준): 오늘 · 내일 · 모레 · 이번 주 금요일 · 다음 주 수요일 오후 3시', () => {
    assert.deepEqual(run('오늘 휴강합니다'), [allDay('cancellation', '2026-11-12')])
    assert.deepEqual(run('내일 퀴즈'), [allDay('exam', '2026-11-13')])
    assert.deepEqual(run('모레 보강'), [allDay('makeup', '2026-11-14')])
    assert.deepEqual(run('이번 주 금요일까지 과제 제출'), [allDay('deadline', '2026-11-13')])
    assert.deepEqual(run('이번주 월요일 보강'), [allDay('makeup', '2026-11-09')])
    assert.deepEqual(run('다음 주 수요일 오후 3시 보강'), [timed('makeup', '2026-11-18T15:00:00+09:00', '2026-11-18T16:00:00+09:00')])
    assert.deepEqual(run('다음주 월요일 시험'), [allDay('exam', '2026-11-16')])
  })

  it('상대 날짜 기준은 UTC가 아니라 서울 날짜: 11-12T16:00Z(서울 11-13 01:00) 게시의 "내일"은 11-14', () => {
    assert.deepEqual(run('내일 퀴즈', { postedAt: new Date('2026-11-12T16:00:00Z') }), [allDay('exam', '2026-11-14')])
  })

  it('연도 없는 날짜는 게시일과 가장 가까운 날짜(앞뒤 상관없이): 12월 20일 게시의 1월 5일 → 다음 해, 1월 3일 게시의 12월 28일 → 전 해', () => {
    const december = new Date('2026-12-20T00:00:00Z')
    assert.deepEqual(run('1월 5일 기말고사', { postedAt: december }), [allDay('exam', '2027-01-05')])
    assert.deepEqual(run('1/5 기말고사', { postedAt: december }), [allDay('exam', '2027-01-05')])
    assert.deepEqual(run('12월 20일 기말고사', { postedAt: december }), [allDay('exam', '2026-12-20')])
    assert.deepEqual(run('11월 5일 시험'), [allDay('exam', '2026-11-05')], '11-12 게시의 11월 5일은 올해 (지난 날짜는 제안 단계에서 빠짐)')
    assert.deepEqual(run('11월 20일 시험'), [allDay('exam', '2026-11-20')])
    assert.deepEqual(run('12월 28일 시험', { postedAt: new Date('2026-01-03T00:00:00Z') }), [allDay('exam', '2025-12-28')])
    assert.deepEqual(run('2027.11.5 시험'), [allDay('exam', '2027-11-05')], '연도가 적힌 날짜는 그대로')
  })

  it('교시: N교시 · N~M교시 → 시간표 시각, 시간표가 비어 있으면 날짜만(하루 종일)', () => {
    assert.deepEqual(run('11월 20일 3교시 퀴즈'), [timed('exam', '2026-11-20T11:00:00+09:00', '2026-11-20T11:50:00+09:00')])
    assert.deepEqual(run('11월 20일 3~4교시 시험'), [timed('exam', '2026-11-20T11:00:00+09:00', '2026-11-20T12:50:00+09:00')])
    assert.deepEqual(run('11월 20일 3-4교시 시험'), [timed('exam', '2026-11-20T11:00:00+09:00', '2026-11-20T12:50:00+09:00')])
    assert.deepEqual(run('11월 20일 9교시 시험'), [allDay('exam', '2026-11-20')], '시간표에 없는 교시는 날짜만')
    assert.deepEqual(run('11월 20일 3교시 퀴즈', { using: noPeriods }), [allDay('exam', '2026-11-20')])
  })

  it('종류: 시험(중간고사 · 기말고사 · 퀴즈 · 쪽지시험) · 휴강 · 보강 · 마감(마감 · 제출 · 기한) · 그 외 기타', () => {
    const kinds = ['중간고사', '기말고사', '퀴즈', '쪽지시험', 'Quiz', '휴강', '보강', '레포트 마감', '과제 제출', '제출 기한', '특강'].map((word) => run(`11월 20일 ${word}`)[0][0])

    assert.deepEqual(kinds, ['exam', 'exam', 'exam', 'exam', 'exam', 'cancellation', 'makeup', 'deadline', 'deadline', 'deadline', 'other'])
  })

  it('한 줄에 날짜가 여럿이면 날짜마다 가까운 구절의 종류: "11/19 휴강, 11/26 보강"', () => {
    assert.deepEqual(run('11/19 휴강, 11/26 보강'), [allDay('cancellation', '2026-11-19'), allDay('makeup', '2026-11-26')])
  })

  it('본문 구절에 종류 단어가 없으면 공지 제목으로 정한다', () => {
    assert.deepEqual(run('일시: 11월 20일 오후 2시\n장소: 공학관', { title: '중간고사 안내' }), [timed('exam', '2026-11-20T14:00:00+09:00', '2026-11-20T15:00:00+09:00')])
  })

  it('여러 줄 · 여러 날짜는 본문 순서대로 모두 (상한 · 지난 날짜 · 중복은 추출기 밖에서)', () => {
    const text = '1차 퀴즈: 11월 20일\n2차 퀴즈: 11월 27일\n기말고사: 12월 18일 오후 2시\n1차 퀴즈: 11월 20일'

    assert.deepEqual(run(text).map((c) => c[1].slice(0, 10)), ['2026-11-19', '2026-11-26', '2026-12-18', '2026-11-19'])
  })

  it('결과 항목 모양: { kind, startAt, endAt, isAllDay, context } 다섯 칸', () => {
    const [candidate] = extractor.extract({ title: '', text: '11월 20일 시험', postedAt: POSTED })

    assert.deepEqual(Object.keys(candidate).sort(), ['context', 'endAt', 'isAllDay', 'kind', 'startAt'])
    assert.ok(candidate.startAt instanceof Date && candidate.endAt instanceof Date)
  })
})
