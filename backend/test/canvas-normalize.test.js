import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  safeCanvasUrl,
  normalizeCourse,
  normalizeAssignment,
  normalizeAnnouncement,
  TITLE_MAX_LENGTH,
  URL_MAX_LENGTH,
  BODY_MAX_BYTES,
  UNTITLED,
} from '../src/lms/canvas-normalize.js'
import { canvasAssignment, canvasAnnouncement, CANVAS_BASE_URL } from './helpers/fake-canvas.js'

const OPTIONS = { baseUrl: CANVAS_BASE_URL }
const HEX_64 = /^[0-9a-f]{64}$/

describe('Canvas 링크 규칙 (CANVAS_BASE_URL과 같은 출처의 https만)', () => {
  it('같은 출처면 그대로', () => {
    assert.equal(safeCanvasUrl(`${CANVAS_BASE_URL}/courses/1/assignments/2`, OPTIONS), `${CANVAS_BASE_URL}/courses/1/assignments/2`)
  })

  it('다른 출처 · http · 계정 정보 · 상대 경로 · 스크립트 · 너무 긴 값 · 문자열 아님 → null', () => {
    const rejected = [
      'https://evil.test/courses/1',
      'http://canvas.test/courses/1',
      'https://canvas.test.evil.test/courses/1',
      'https://canvas.test:8443/courses/1',
      'https://user:pw@canvas.test/courses/1',
      '/courses/1',
      'javascript:alert(1)',
      `${CANVAS_BASE_URL}/${'a'.repeat(URL_MAX_LENGTH)}`,
      '',
      null,
      123,
    ]
    assert.ok(safeCanvasUrl(`${CANVAS_BASE_URL}/ok`, OPTIONS), '대조: 같은 출처는 통과해야 함')
    for (const value of rejected) {
      assert.equal(safeCanvasUrl(value, OPTIONS), null, String(value).slice(0, 60))
    }
  })

  it('개발용 http 주소가 base면 같은 출처의 http 링크는 허용', () => {
    assert.equal(safeCanvasUrl('http://localhost:3000/courses/1', { baseUrl: 'http://localhost:3000' }), 'http://localhost:3000/courses/1')
  })
})

describe('과목 정리', () => {
  it('id · 이름만 꺼낸다', () => {
    assert.deepEqual(normalizeCourse({ id: 101, name: '자료구조', course_code: 'DS' }), { canvasCourseId: 101, name: '자료구조' })
  })

  it('이름이 255자를 넘으면 코드포인트 255자로 자른다 (이모지를 반으로 깨지 않음)', () => {
    assert.equal(normalizeCourse({ id: 1, name: '가'.repeat(300) }).name, '가'.repeat(TITLE_MAX_LENGTH))
    assert.equal(normalizeCourse({ id: 1, name: '😀'.repeat(300) }).name, '😀'.repeat(TITLE_MAX_LENGTH))
  })

  it('이름이 없거나 접근 제한 과목 · id가 양의 정수가 아니면 건너뛴다(null)', () => {
    assert.ok(normalizeCourse({ id: 1, name: 'x', access_restricted_by_date: false }), '대조: 정상 과목은 통과')
    for (const raw of [{ id: 1 }, { id: 1, name: '' }, { id: 1, name: 'x', access_restricted_by_date: true }, { id: 'abc', name: 'x' }, { id: 0, name: 'x' }, { id: 1.5, name: 'x' }, null]) {
      assert.equal(normalizeCourse(raw), null, JSON.stringify(raw))
    }
  })

  it('큰 Canvas id(샤드 id)도 받는다', () => {
    assert.equal(normalizeCourse({ id: 10000000000123, name: 'x' }).canvasCourseId, 10000000000123)
  })
})

describe('과제 정리', () => {
  it('Canvas id · 제목 · 링크 · 마감(Date) · 해시', () => {
    const result = normalizeAssignment(canvasAssignment(101, 501, { name: '과제 1', dueAt: '2026-11-20T14:59:00Z' }), OPTIONS)

    assert.equal(result.canvasId, 501)
    assert.equal(result.title, '과제 1')
    assert.equal(result.htmlUrl, `${CANVAS_BASE_URL}/courses/101/assignments/501`)
    assert.deepEqual(result.dueAt, new Date('2026-11-20T14:59:00Z'))
    assert.match(result.contentHash, HEX_64)
  })

  it('미게시 과제 · id가 이상한 과제는 건너뛴다', () => {
    assert.ok(normalizeAssignment(canvasAssignment(101, 1, { published: true }), OPTIONS), '대조: 게시된 과제는 통과')
    assert.equal(normalizeAssignment(canvasAssignment(101, 1, { published: false }), OPTIONS), null)
    assert.equal(normalizeAssignment(canvasAssignment(101, -1), OPTIONS), null)
  })

  it('제목: 없으면 "(제목 없음)", 길면 255자로 자른다', () => {
    const { name: _omitted, ...withoutName } = canvasAssignment(101, 1)
    assert.equal(normalizeAssignment(withoutName, OPTIONS).title, UNTITLED)
    for (const name of ['', 42]) {
      assert.equal(normalizeAssignment(canvasAssignment(101, 1, { name }), OPTIONS).title, UNTITLED)
    }
    assert.equal(normalizeAssignment(canvasAssignment(101, 1, { name: 'a'.repeat(300) }), OPTIONS).title.length, TITLE_MAX_LENGTH)
  })

  it('마감을 읽을 수 없으면 null, 링크가 규칙에 어긋나면 null (과제는 남는다)', () => {
    const result = normalizeAssignment(canvasAssignment(101, 1, { dueAt: 'not a date', htmlUrl: 'https://evil.test/x' }), OPTIONS)

    assert.equal(result.dueAt, null)
    assert.equal(result.htmlUrl, null)
  })

  it('해시는 공유 값(제목 · 링크)으로만: 같으면 같고, 제목이 바뀌면 다르고, 사용자별 마감이 바뀌어도 그대로', () => {
    const base = normalizeAssignment(canvasAssignment(101, 1, { dueAt: '2026-11-20T00:00:00Z' }), OPTIONS).contentHash

    assert.equal(normalizeAssignment(canvasAssignment(101, 1, { dueAt: '2026-11-20T00:00:00Z' }), OPTIONS).contentHash, base)
    assert.equal(normalizeAssignment(canvasAssignment(101, 1, { dueAt: '2026-12-01T00:00:00Z' }), OPTIONS).contentHash, base)
    assert.notEqual(normalizeAssignment(canvasAssignment(101, 1, { name: '바뀐 제목' }), OPTIONS).contentHash, base)
  })
})

describe('공지 정리', () => {
  const posted = '2026-11-10T01:00:00Z'

  it('Canvas id · 제목 · HTML 본문(그대로) · 링크 · 게시 시각 · 해시', () => {
    const result = normalizeAnnouncement(canvasAnnouncement(101, 701, { title: '휴강', message: '<p onclick="x()">휴강</p>', postedAt: posted }), OPTIONS)

    assert.deepEqual(
      { ...result, contentHash: undefined },
      { canvasId: 701, title: '휴강', body: '<p onclick="x()">휴강</p>', htmlUrl: `${CANVAS_BASE_URL}/courses/101/discussion_topics/701`, postedAt: new Date(posted), contentHash: undefined },
    )
    assert.match(result.contentHash, HEX_64)
  })

  it('본문이 1 MiB(UTF-8 바이트)를 넘으면 null, 딱 맞으면 그대로 (HTML을 자르지 않는다)', () => {
    const fits = 'a'.repeat(BODY_MAX_BYTES)
    const koreanOver = '한'.repeat(Math.ceil((BODY_MAX_BYTES + 1) / 3))

    assert.equal(normalizeAnnouncement(canvasAnnouncement(101, 1, { message: fits, postedAt: posted }), OPTIONS).body, fits)
    assert.equal(normalizeAnnouncement(canvasAnnouncement(101, 1, { message: `${fits}a`, postedAt: posted }), OPTIONS).body, null)
    assert.equal(normalizeAnnouncement(canvasAnnouncement(101, 1, { message: koreanOver, postedAt: posted }), OPTIONS).body, null)
  })

  it('본문이 문자열이 아니면 null, 게시 시각을 읽을 수 없으면 null', () => {
    const result = normalizeAnnouncement(canvasAnnouncement(101, 1, { message: { html: 'x' }, postedAt: 'later' }), OPTIONS)

    assert.equal(result.body, null)
    assert.equal(result.postedAt, null)
  })

  it('해시는 본문이 바뀌면 달라진다', () => {
    const hash = (message) => normalizeAnnouncement(canvasAnnouncement(101, 1, { message, postedAt: posted }), OPTIONS).contentHash

    assert.equal(hash('<p>a</p>'), hash('<p>a</p>'))
    assert.notEqual(hash('<p>a</p>'), hash('<p>b</p>'))
  })
})
