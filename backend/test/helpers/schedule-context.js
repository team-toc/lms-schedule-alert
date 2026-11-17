// 일정 · iCloud 테스트 공용 도구 (ADR 0010): 가짜 Canvas + 가짜 iCloud를 끼운 앱, 경로, DB 읽기
import { createLmsServices } from '../../src/lms/lms-services.js'
import { createFakeKakaoClient } from './fake-kakao-client.js'
import { createFakeCanvas } from './fake-canvas.js'
import { createFakeIcloud } from './fake-icloud.js'
import { createLmsClock, TEST_LMS_CONFIG } from './lms-context.js'

export const SCHEDULES_PATH = '/api/calendar/schedules'
export const schedulePath = (id) => `${SCHEDULES_PATH}/${id}`
export const LINKS_PATH = '/api/calendar/links'
export const ICLOUD_LINKS_PATH = '/api/calendar/links/icloud'
export const linkPath = (id) => `${LINKS_PATH}/${id}`
export const linkSyncPath = (id) => `${LINKS_PATH}/${id}/sync`
export const EVENTS_PATH = '/api/calendar/events'
export const CONFLICTS_PATH = '/api/calendar/conflicts'

// 시계는 2026-11-13T00:00Z에서 시작 → 동기화 창은 2026-10-14 ~ 2027-05-12
export const NOW_ISO = '2026-11-13T00:00:00.000Z'

// 공개 링크 토큰 (불투명 문자열, 로그 검사에서 찾는다)
export const LINK_TOKEN_A = 'MTAwMDAwMDAwMDAwTOKENAAAAsecretPartForLogCheck00000000AAAA'
export const LINK_TOKEN_B = 'MTAwMDAwMDAwMDAwTOKENBBBBsecretPartForLogCheck00000000BBBB'

// pool: 장애를 끼워 넣은 풀을 쓸 때만. icloud · canvas: 가짜 fetch
export function buildScheduleApp(ctx, { canvas = createFakeCanvas(), icloud = createFakeIcloud(), clock = createLmsClock(), logger = ctx.silentLogger, pool = ctx.pool } = {}) {
  const lms = createLmsServices({ pool, logger, lmsConfig: TEST_LMS_CONFIG, fetchFn: canvas.fetch, icloudFetchFn: icloud.fetch, now: clock.now })
  const app = ctx.buildApp(createFakeKakaoClient(), { lmsServices: lms, logger })
  return { app, lms, clock, canvas, icloud }
}

// 등록 + 첫 동기화(백그라운드)까지 기다림
export async function registerLink(built, agent, url) {
  const res = await agent.post(ICLOUD_LINKS_PATH).send({ url })
  await built.lms.calendarSyncRunner.whenIdle()
  return res
}

const iso = (value) => value?.toISOString() ?? null

// 사용자의 일정 행 (지워진 것 포함, id 순)
export async function scheduleRows(pool, userId) {
  const [rows] = await pool.query('SELECT * FROM schedules WHERE user_id = ? ORDER BY id', [userId])
  return rows.map((r) => ({ ...r }))
}

// 살아 있는 일정만 (제목 · 시각, 시작 순)
export async function liveSchedules(pool, userId) {
  const [rows] = await pool.query(
    'SELECT id, source, title, start_at, end_at, is_all_day FROM schedules WHERE user_id = ? AND deleted_at IS NULL ORDER BY start_at, id',
    [userId],
  )
  return rows.map((r) => ({ id: r.id, source: r.source, title: r.title, startAt: iso(r.start_at), endAt: iso(r.end_at), isAllDay: Boolean(r.is_all_day) }))
}

export async function linkRows(pool, userId) {
  const [rows] = await pool.query('SELECT * FROM calendar_links WHERE user_id = ? ORDER BY id', [userId])
  return rows.map((r) => ({ ...r }))
}

// 앱 일정 하나 만들기 (API). supertest 요청을 그대로 돌려줘 .expect()를 이어 쓸 수 있게 async가 아니다
export function createAppSchedule(agent, { title = '일정', startAt, endAt, isAllDay } = {}) {
  const body = { title, startAt, endAt }
  if (isAllDay !== undefined) body.isAllDay = isAllDay
  return agent.post(SCHEDULES_PATH).send(body)
}
