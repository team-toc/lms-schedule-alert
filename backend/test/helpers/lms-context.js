// Canvas 연동 테스트 공용 도구: 고정 설정 · 시계 · 앱 조립 · 로그인 · DB 상태 읽기
import request from 'supertest'
import { createLmsServices } from '../../src/lms/lms-services.js'
import { createTokenCipher } from '../../src/lms/token-cipher.js'
import { createFakeKakaoClient } from './fake-kakao-client.js'
import { signup, VALID_PASSWORD } from './email-flow.js'
import { CANVAS_BASE_URL } from './fake-canvas.js'

export const TOKEN_PATH = '/api/lms/token'
export const STATUS_PATH = '/api/lms/status'
export const SYNC_PATH = '/api/lms/sync'
export const CALENDAR_PATH = '/api/calendar/events'
export const MINUTE_MS = 60 * 1000
export const DAY_MS = 24 * 60 * MINUTE_MS

// 테스트 안에 고정한 Canvas 설정 (개발자 .env를 읽지 않는다)
export const TEST_TOKEN_KEY = Buffer.alloc(32, 7)
export const TEST_LMS_CONFIG = { canvasBaseUrl: CANVAS_BASE_URL, tokenKey: TEST_TOKEN_KEY, syncIntervalMs: 30 * MINUTE_MS }

// Canvas 개인 토큰 모양(<숫자>~<영숫자>). 로그 검사에서 이 값 · 일부 · 해시를 찾는다
export const TOKEN_A = '7~TokenAAAA0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX'
export const TOKEN_B = '7~TokenBBBB0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX'

export function createLmsClock(startMs = Date.UTC(2026, 10, 13, 0, 0, 0)) {
  let current = startMs
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms
    },
  }
}

export const testTokenCipher = () => createTokenCipher({ key: TEST_TOKEN_KEY })

// 가짜 Canvas · 시계 · 로거를 끼운 LMS 서비스와 앱. lms.syncRunner.whenIdle()로 백그라운드 동기화를 기다린다
// pool: 장애를 끼워 넣은 풀(예상 밖 에러 테스트)을 쓸 때만 넘긴다
export function buildLmsApp(ctx, { canvas, clock = createLmsClock(), logger = ctx.silentLogger, pool = ctx.pool } = {}) {
  const lms = createLmsServices({ pool, logger, lmsConfig: TEST_LMS_CONFIG, fetchFn: canvas.fetch, now: clock.now })
  const app = ctx.buildApp(createFakeKakaoClient(), { lmsServices: lms, logger })
  return { app, lms, clock }
}

export async function signedInUser(app, email = 'student@example.com') {
  const agent = request.agent(app)
  const res = await signup(agent, { email, password: VALID_PASSWORD }).expect(201)
  return { agent, userId: res.body.id }
}

export function registerToken(agent, token) {
  return agent.post(TOKEN_PATH).send({ token })
}

// 토큰 등록 + 첫 동기화 완료까지
export async function connectUser({ app, lms }, { email, token }) {
  const user = await signedInUser(app, email)
  await registerToken(user.agent, token).expect(202)
  await lms.syncRunner.whenIdle()
  return user
}

export async function tokenRow(pool, userId) {
  const [rows] = await pool.query('SELECT * FROM lms_tokens WHERE user_id = ?', [userId])
  return rows[0] ?? null
}

export async function onboardingStep(pool, userId) {
  const [[row]] = await pool.query('SELECT onboarding_step FROM users WHERE id = ?', [userId])
  return row.onboarding_step
}

// 사용자에게 연결된 것들을 Canvas id로 돌려준다 (정렬됨)
export async function userLinks(pool, userId) {
  const [courses] = await pool.query(
    'SELECT c.canvas_course_id AS id FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = ? ORDER BY id',
    [userId],
  )
  const [assignments] = await pool.query(
    `SELECT a.canvas_id AS id, ua.due_at AS dueAt FROM user_assignments ua JOIN assignments a ON a.id = ua.assignment_id
     WHERE ua.user_id = ? ORDER BY a.canvas_id`,
    [userId],
  )
  const [announcements] = await pool.query(
    `SELECT n.canvas_id AS id FROM user_announcements un JOIN announcements n ON n.id = un.announcement_id
     WHERE un.user_id = ? ORDER BY n.canvas_id`,
    [userId],
  )
  return {
    courses: courses.map((r) => Number(r.id)),
    assignments: assignments.map((r) => ({ id: Number(r.id), dueAt: r.dueAt?.toISOString() ?? null })),
    announcements: announcements.map((r) => Number(r.id)),
  }
}

const SNAPSHOT_TABLES = ['lms_tokens', 'courses', 'enrollments', 'assignments', 'user_assignments', 'announcements', 'user_announcements']

// 7개 테이블의 모든 행(시각 칼럼 포함). "아무것도 바뀌지 않았다"를 확인할 때 쓴다
export async function snapshotLmsTables(pool) {
  const snapshot = {}
  for (const table of SNAPSHOT_TABLES) {
    const [rows] = await pool.query('SELECT * FROM ?? ORDER BY 1, 2', [table])
    snapshot[table] = rows.map((row) => ({ ...row }))
  }
  return snapshot
}

// 가짜 Canvas 요청을 테스트가 풀어 줄 때까지 붙잡는다: reached(요청이 도착함) → 테스트가 할 일 → release()
export function holdRequests(canvas, match) {
  let markReached
  let release
  const reached = new Promise((resolve) => {
    markReached = resolve
  })
  const released = new Promise((resolve) => {
    release = resolve
  })
  canvas.intercept(
    match,
    async () => {
      markReached()
      await released
    },
    { times: 1 },
  )
  return { reached, release }
}
