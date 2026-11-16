// 공지 일정 제안 테스트 공용 도구 (ADR 0011): 예시 교시 시간표, 앱 조립(추출기 · 훅 바꿔 끼우기), 경로, DB 읽기 · 넣기
import { createHash } from 'node:crypto'
import { createLmsServices } from '../../src/lms/lms-services.js'
import { parseClassPeriods } from '../../src/suggestions/class-periods.js'
import { createFakeKakaoClient } from './fake-kakao-client.js'
import { createFakeCanvas } from './fake-canvas.js'
import { createLmsClock, TEST_LMS_CONFIG } from './lms-context.js'

export const SUGGESTIONS_PATH = '/api/suggestions'
export const acceptPath = (id) => `${SUGGESTIONS_PATH}/${id}/accept`
export const rejectPath = (id) => `${SUGGESTIONS_PATH}/${id}/reject`

// 테스트용 예시 시간표(실제 학교 시간표 아님). 1교시 09:00 ~ 09:50, 50분 수업 · 10분 쉬는 시간
export const EXAMPLE_CLASS_PERIODS = {
  periods: [
    { period: 1, start: '09:00', end: '09:50' },
    { period: 2, start: '10:00', end: '10:50' },
    { period: 3, start: '11:00', end: '11:50' },
    { period: 4, start: '12:00', end: '12:50' },
    { period: 5, start: '13:00', end: '13:50' },
    { period: 6, start: '14:00', end: '14:50' },
  ],
}

// extractor: 추출기를 바꿔 끼울 때(예외 던지기 등). afterCanvasApplied: Canvas 반영 뒤 훅을 직접 바꿔 끼울 때
export function buildSuggestionApp(ctx, { canvas = createFakeCanvas(), clock = createLmsClock(), logger = ctx.silentLogger, pool = ctx.pool, classPeriods = EXAMPLE_CLASS_PERIODS, extractor, afterCanvasApplied } = {}) {
  const lms = createLmsServices({
    pool,
    logger,
    lmsConfig: TEST_LMS_CONFIG,
    fetchFn: canvas.fetch,
    now: clock.now,
    classPeriods: parseClassPeriods(classPeriods),
    suggestionExtractor: extractor,
    afterCanvasApplied,
  })
  const app = ctx.buildApp(createFakeKakaoClient(), { lmsServices: lms, logger })
  return { app, lms, clock, canvas }
}

const iso = (value) => value?.toISOString() ?? null

// 사용자의 제안 (id 순)
export async function suggestionRows(pool, userId) {
  const [rows] = await pool.query(
    `SELECT s.*, a.canvas_id AS announcement_canvas_id FROM suggestions s JOIN announcements a ON a.id = s.announcement_id
     WHERE s.user_id = ? ORDER BY s.id`,
    [userId],
  )
  return rows.map((r) => ({ ...r }))
}

// 비교용 요약: [종류, 시작, 끝, 하루 종일, 상태]
export async function suggestionSummary(pool, userId) {
  return (await suggestionRows(pool, userId)).map((r) => [r.kind, iso(r.start_at), iso(r.end_at), Boolean(r.is_all_day), r.status])
}

export async function countRows(pool, table, userId) {
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM ?? WHERE user_id = ?', [table, userId])
  return Number(row.n)
}

export async function announcementId(pool, canvasId) {
  const [[row]] = await pool.query('SELECT id FROM announcements WHERE canvas_id = ?', [canvasId])
  return row.id
}

// API 테스트용: 제안 행을 직접 넣는다 (추출과 떼어 목록 · 수락 · 거절만 본다)
export async function insertSuggestion(pool, { userId, announcementId: aid, kind = 'exam', startAt, endAt, isAllDay = false, context = '중간고사 11월 20일 오후 2시', status = 'pending' }) {
  const key = createHash('sha256').update(`${startAt}|${endAt}|${isAllDay}|${Math.random()}`).digest('hex')
  const [result] = await pool.execute(
    'INSERT INTO suggestions (user_id, announcement_id, candidate_key, kind, start_at, end_at, is_all_day, context, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, aid, key, kind, new Date(startAt), new Date(endAt), isAllDay, context, status],
  )
  return result.insertId
}
