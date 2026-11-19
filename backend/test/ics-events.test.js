import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseIcsEvents, IcsParseError, ICS_ERRORS } from '../src/calendar/ics-events.js'
import { ics, vevent } from './helpers/ics-builder.js'

// 동기화 창: 2026-11-13 기준 −30일 ~ +180일
const WINDOW = { windowStart: new Date('2026-10-14T00:00:00Z'), windowEnd: new Date('2027-05-12T00:00:00Z') }
const NORMALIZED_KEYS = ['sourceType', 'externalId', 'title', 'startAt', 'endAt', 'isAllDay', 'status', 'updatedAt']

const parse = (text, options = {}) => parseIcsEvents(text, { ...WINDOW, ...options })
const times = (events) => events.map((e) => [e.startAt.toISOString(), e.endAt.toISOString()])

// ICS → NormalizedEvent (ADR 0010): 회차로 펼치기, 시각은 UTC, 제목만, 취소는 빼고, 깨진 항목은 그것만 건너뜀
describe('ICS 파싱 · 정규화', () => {
  it('단일 일정 → NormalizedEvent 하나 (필드는 정해진 8개뿐, 설명 · 위치는 없음)', () => {
    const text = ics(vevent({
      uid: 'single-1', summary: '자료구조 스터디', start: '2026-11-20T01:00:00Z', end: '2026-11-20T02:30:00Z',
      lastModified: '2026-11-01T09:00:00Z', extra: ['DESCRIPTION:비밀 메모', 'LOCATION:공학관 301'],
    }))

    const { events, skipped } = parse(text)

    assert.equal(skipped, 0)
    assert.equal(events.length, 1)
    const [event] = events
    assert.deepEqual(Object.keys(event).sort(), [...NORMALIZED_KEYS].sort())
    assert.deepEqual({ ...event, externalId: undefined }, {
      sourceType: 'icloud', externalId: undefined, title: '자료구조 스터디',
      startAt: new Date('2026-11-20T01:00:00Z'), endAt: new Date('2026-11-20T02:30:00Z'),
      isAllDay: false, status: 'confirmed', updatedAt: new Date('2026-11-01T09:00:00Z'),
    })
    assert.equal(typeof event.externalId, 'string')
    assert.ok(!JSON.stringify(events).includes('비밀 메모') && !JSON.stringify(events).includes('공학관'))
  })

  it('TZID가 다른 일정은 UTC로: 서울 10:00 → 01:00Z, 뉴욕 09:00(EST) → 14:00Z, 시간대 없는 떠 있는 시각은 서울로 본다', () => {
    const text = ics(
      vevent({ uid: 'seoul', summary: 'S', start: '2026-11-20T10:00:00', end: '2026-11-20T11:00:00', tzid: 'Asia/Seoul' }),
      vevent({ uid: 'ny', summary: 'N', start: '2026-11-20T09:00:00', end: '2026-11-20T10:00:00', tzid: 'America/New_York' }),
      vevent({ uid: 'floating', summary: 'F', start: '2026-11-21T10:00:00', end: '2026-11-21T11:00:00' }),
    )

    const byTitle = Object.fromEntries(parse(text).events.map((e) => [e.title, [e.startAt.toISOString(), e.endAt.toISOString()]]))

    assert.deepEqual(byTitle, {
      S: ['2026-11-20T01:00:00.000Z', '2026-11-20T02:00:00.000Z'],
      N: ['2026-11-20T14:00:00.000Z', '2026-11-20T15:00:00.000Z'],
      F: ['2026-11-21T01:00:00.000Z', '2026-11-21T02:00:00.000Z'],
    })
  })

  it('반복 일정은 창 안의 회차로 펼친다: 회차마다 다른 externalId, 같은 입력이면 같은 externalId, 서머타임이 끝나도 현지 시각 유지', () => {
    const text = ics(vevent({
      uid: 'weekly-ny', summary: '주간 회의', start: '2026-10-26T09:00:00', end: '2026-10-26T10:00:00', tzid: 'America/New_York',
      rrule: 'FREQ=WEEKLY;COUNT=3',
    }))

    const first = parse(text).events
    const again = parse(text).events

    assert.deepEqual(times(first), [
      ['2026-10-26T13:00:00.000Z', '2026-10-26T14:00:00.000Z'],
      ['2026-11-02T14:00:00.000Z', '2026-11-02T15:00:00.000Z'],
      ['2026-11-09T14:00:00.000Z', '2026-11-09T15:00:00.000Z'],
    ])
    assert.equal(new Set(first.map((e) => e.externalId)).size, 3)
    assert.deepEqual(again.map((e) => e.externalId), first.map((e) => e.externalId))
  })

  it('끝없는 반복은 창 끝까지만, 창보다 이른 회차는 빼고(창 시작 −30일) 창에 걸친 회차는 넣는다', () => {
    const text = ics(vevent({ uid: 'daily', summary: '매일', start: '2026-09-01T00:00:00Z', end: '2026-09-01T00:30:00Z', rrule: 'FREQ=DAILY' }))

    const { events } = parse(text)

    assert.equal(events[0].startAt.toISOString(), '2026-10-14T00:00:00.000Z')
    assert.ok(events.at(-1).startAt < WINDOW.windowEnd)
    assert.equal(events.length, 210)
  })

  it('오래전에 시작한 끝없는 반복(2010년부터 매일)도 창 안의 회차만 만들어 성공, 회차 상한은 창 안의 수에만 적용 (처음부터 펼친 뒤 자르지 않음)', () => {
    const text = ics(vevent({ uid: 'since-2010', summary: '아침 운동', start: '2010-01-01T22:00:00Z', end: '2010-01-01T23:00:00Z', rrule: 'FREQ=DAILY' }))
    const started = process.hrtime.bigint()

    const { events } = parse(text, { maxEvents: 5000 })

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    assert.equal(events.length, 210, '창(−30일 ~ +180일) 안의 회차 수')
    assert.equal(events[0].startAt.toISOString(), '2026-10-14T22:00:00.000Z', '창 시작 뒤 첫 회차부터 (10-13 회차는 창 시작 전에 끝남)')
    assert.ok(events.every((e) => e.endAt > WINDOW.windowStart && e.startAt < WINDOW.windowEnd))
    // 2010년부터 전부 펼치면 6000개가 넘어 상한(5000)에 걸린다. 걸리지 않았다는 것 자체가 창 안만 만들었다는 뜻
    assert.ok(elapsedMs < 2000, `너무 느림(처음부터 펼친 것으로 보임): ${elapsedMs}ms`)
  })

  it('EXDATE로 뺀 회차는 없다', () => {
    const text = ics(vevent({
      uid: 'ex', summary: '수업', start: '2026-11-02T10:00:00', end: '2026-11-02T11:00:00', tzid: 'Asia/Seoul',
      rrule: 'FREQ=WEEKLY;COUNT=3', exdates: ['2026-11-09T10:00:00'],
    }))

    assert.deepEqual(parse(text).events.map((e) => e.startAt.toISOString()), ['2026-11-02T01:00:00.000Z', '2026-11-16T01:00:00.000Z'])
  })

  it('RECURRENCE-ID로 한 회차만 바뀌면 그 회차만 새 시각 · 제목, externalId는 원래 회차와 같다', () => {
    const base = vevent({ uid: 'moved', summary: '세미나', start: '2026-11-02T10:00:00', end: '2026-11-02T11:00:00', tzid: 'Asia/Seoul', rrule: 'FREQ=WEEKLY;COUNT=3' })
    const override = vevent({ uid: 'moved', summary: '세미나 (장소 변경)', start: '2026-11-10T15:00:00', end: '2026-11-10T16:00:00', tzid: 'Asia/Seoul', recurrenceId: '2026-11-09T10:00:00' })

    const original = parse(ics(base)).events
    const changed = parse(ics(base, override)).events

    assert.deepEqual(changed.map((e) => [e.title, e.startAt.toISOString()]), [
      ['세미나', '2026-11-02T01:00:00.000Z'],
      ['세미나 (장소 변경)', '2026-11-10T06:00:00.000Z'],
      ['세미나', '2026-11-16T01:00:00.000Z'],
    ])
    assert.deepEqual(changed.map((e) => e.externalId), original.map((e) => e.externalId), '옮겨진 회차도 같은 키')
  })

  it('취소: STATUS:CANCELLED 일정 · 취소된 회차(RECURRENCE-ID + CANCELLED)는 빠진다, TENTATIVE는 status로', () => {
    const text = ics(
      vevent({ uid: 'cancelled', summary: '취소', start: '2026-11-20T01:00:00Z', end: '2026-11-20T02:00:00Z', status: 'CANCELLED' }),
      vevent({ uid: 'rec', summary: '반복', start: '2026-11-02T01:00:00Z', end: '2026-11-02T02:00:00Z', rrule: 'FREQ=WEEKLY;COUNT=3' }),
      vevent({ uid: 'rec', summary: '반복', start: '2026-11-09T01:00:00Z', end: '2026-11-09T02:00:00Z', recurrenceId: '2026-11-09T01:00:00Z', status: 'CANCELLED' }),
      vevent({ uid: 'maybe', summary: '미정', start: '2026-11-21T01:00:00Z', end: '2026-11-21T02:00:00Z', status: 'TENTATIVE' }),
    )

    const { events } = parse(text)

    assert.deepEqual(events.map((e) => [e.title, e.startAt.toISOString(), e.status]), [
      ['반복', '2026-11-02T01:00:00.000Z', 'confirmed'],
      ['반복', '2026-11-16T01:00:00.000Z', 'confirmed'],
      ['미정', '2026-11-21T01:00:00.000Z', 'tentative'],
    ])
  })

  it('하루 종일: 날짜 → 서울 자정 ~ 다음 자정(UTC), DTEND 없으면 하루, 여러 날도', () => {
    const text = ics(
      vevent({ uid: 'day', summary: '휴일', start: '2026-11-20', end: '2026-11-21' }),
      vevent({ uid: 'noend', summary: '기념일', start: '2026-11-22' }),
      vevent({ uid: 'trip', summary: '여행', start: '2026-11-25', end: '2026-11-28' }),
    )

    const byTitle = Object.fromEntries(parse(text).events.map((e) => [e.title, [e.startAt.toISOString(), e.endAt.toISOString(), e.isAllDay]]))

    assert.deepEqual(byTitle, {
      휴일: ['2026-11-19T15:00:00.000Z', '2026-11-20T15:00:00.000Z', true],
      기념일: ['2026-11-21T15:00:00.000Z', '2026-11-22T15:00:00.000Z', true],
      여행: ['2026-11-24T15:00:00.000Z', '2026-11-27T15:00:00.000Z', true],
    })
  })

  it('길이 0(시작 = 끝 · DTEND 없는 시각 일정)은 그대로 두고, DURATION은 끝 시각으로 바꾼다', () => {
    const text = ics(
      vevent({ uid: 'zero', summary: '알림만', start: '2026-11-20T01:00:00Z', end: '2026-11-20T01:00:00Z' }),
      vevent({ uid: 'noend', summary: '끝 없음', start: '2026-11-20T03:00:00Z' }),
      vevent({ uid: 'dur', summary: '90분', start: '2026-11-20T05:00:00Z', duration: 'PT1H30M' }),
    )

    assert.deepEqual(times(parse(text).events), [
      ['2026-11-20T01:00:00.000Z', '2026-11-20T01:00:00.000Z'],
      ['2026-11-20T03:00:00.000Z', '2026-11-20T03:00:00.000Z'],
      ['2026-11-20T05:00:00.000Z', '2026-11-20T06:30:00.000Z'],
    ])
  })

  it('끝이 시작보다 앞선 깨진 일정 · 시작 없는 일정 · UID 없는 일정은 그 항목만 건너뛰고 개수를 센다', () => {
    const text = ics(
      vevent({ uid: 'ok', summary: '정상', start: '2026-11-20T01:00:00Z', end: '2026-11-20T02:00:00Z' }),
      vevent({ uid: 'backwards', summary: '거꾸로', start: '2026-11-20T05:00:00Z', end: '2026-11-20T04:00:00Z' }),
      vevent({ uid: 'nostart', summary: '시작 없음' }),
      ['BEGIN:VEVENT', 'DTSTAMP:20261101T000000Z', 'SUMMARY:UID 없음', 'DTSTART:20261120T060000Z', 'DTEND:20261120T070000Z', 'END:VEVENT'].join('\r\n'),
    )

    const { events, skipped } = parse(text)

    assert.deepEqual(events.map((e) => e.title), ['정상'])
    assert.equal(skipped, 3)
  })

  it('제목: 255 코드포인트로 자르고(이모지도 한 글자), 없으면 (제목 없음), ICS 이스케이프는 풀린다', () => {
    const text = ics(
      vevent({ uid: 'long', summary: '😀'.repeat(300), start: '2026-11-20T01:00:00Z', end: '2026-11-20T02:00:00Z' }),
      vevent({ uid: 'none', start: '2026-11-20T03:00:00Z', end: '2026-11-20T04:00:00Z' }),
      vevent({ uid: 'esc', summary: '시험, 준비; 끝', start: '2026-11-20T05:00:00Z', end: '2026-11-20T06:00:00Z' }),
    )

    const titles = parse(text).events.map((e) => e.title)

    assert.equal([...titles[0]].length, 255)
    assert.deepEqual(titles.slice(1), ['(제목 없음)', '시험, 준비; 끝'])
  })

  it('일정이 하나도 없는 캘린더는 빈 목록 (실패 아님)', () => {
    assert.deepEqual(parse(ics()), { events: [], skipped: 0 })
  })

  it('깨진 ICS(빈 문자열 · HTML · VCALENDAR가 닫히지 않음 · 아무 글자)는 icloud_parse_failed', () => {
    for (const text of ['', '<html><body>maintenance</body></html>', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\n', 'hello world']) {
      assert.throws(() => parse(text), (err) => err instanceof IcsParseError && err.code === ICS_ERRORS.parseFailed, JSON.stringify(text.slice(0, 20)))
    }
  })

  it('펼친 뒤 일정 수가 상한(maxEvents)을 넘으면 icloud_too_many_events (일부만 돌려주지 않음)', () => {
    const text = ics(vevent({ uid: 'many', summary: '매일', start: '2026-10-14T00:00:00Z', end: '2026-10-14T00:30:00Z', rrule: 'FREQ=DAILY' }))

    assert.throws(() => parse(text, { maxEvents: 100 }), (err) => err instanceof IcsParseError && err.code === ICS_ERRORS.tooManyEvents)
    assert.equal(parse(text, { maxEvents: 210 }).events.length, 210)
  })
})
