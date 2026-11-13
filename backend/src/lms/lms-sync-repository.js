// 사용자 한 명의 동기화 결과를 한 트랜잭션으로 반영하는 경계 레이어 (ADR 0008).
// 공유 행(과목 · 과제 · 공지)은 upsert, 사용자 연결은 이번 목록과 비교해 추가 · 삭제한다.
// 연결이 하나도 남지 않은 공유 행은 지우지 않고 deleted_at만 채운다. 표 · 칼럼 이름은 아래 상수만 쓴다(입력값 아님).
import { runInTransaction } from '../db/transaction.js'

const KINDS = {
  assignment: { table: 'assignments', linkTable: 'user_assignments', column: 'assignment_id' },
  announcement: { table: 'announcements', linkTable: 'user_announcements', column: 'announcement_id' },
}

const UPSERT_COURSES = 'INSERT INTO courses (canvas_course_id, name) VALUES ? ON DUPLICATE KEY UPDATE name = VALUES(name)'
// 값이 같으면 행이 바뀌지 않아 updated_at도 그대로다(다시 동기화해도 멱등)
const UPSERT_ASSIGNMENTS = `INSERT INTO assignments (course_id, canvas_id, title, html_url, content_hash) VALUES ?
  ON DUPLICATE KEY UPDATE title = VALUES(title), html_url = VALUES(html_url), content_hash = VALUES(content_hash), deleted_at = NULL`
const UPSERT_USER_ASSIGNMENTS = 'INSERT INTO user_assignments (user_id, assignment_id, due_at) VALUES ? ON DUPLICATE KEY UPDATE due_at = VALUES(due_at)'
const UPSERT_ANNOUNCEMENTS = `INSERT INTO announcements (course_id, canvas_id, title, body, html_url, posted_at, content_hash) VALUES ?
  ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body), html_url = VALUES(html_url), posted_at = VALUES(posted_at),
    content_hash = VALUES(content_hash), deleted_at = NULL`
// INSERT IGNORE는 외래키 오류까지 경고로 숨기므로 쓰지 않는다. 이미 있으면 아무것도 바꾸지 않는다
const UPSERT_USER_ANNOUNCEMENTS = 'INSERT INTO user_announcements (user_id, announcement_id) VALUES ? ON DUPLICATE KEY UPDATE announcement_id = announcement_id'

async function upsertCourses(connection, courses) {
  if (courses.length === 0) {
    return new Map()
  }
  await connection.query(UPSERT_COURSES, [courses.map((c) => [c.canvasCourseId, c.name])])
  const [rows] = await connection.query('SELECT id, canvas_course_id FROM courses WHERE canvas_course_id IN (?)', [courses.map((c) => c.canvasCourseId)])
  return new Map(rows.map((row) => [Number(row.canvas_course_id), row.id]))
}

async function idsByCanvasId(connection, kind, courseId, canvasIds) {
  const [rows] = await connection.query(`SELECT id, canvas_id FROM ${KINDS[kind].table} WHERE course_id = ? AND canvas_id IN (?)`, [courseId, canvasIds])
  return new Map(rows.map((row) => [Number(row.canvas_id), row.id]))
}

// 사용자의 연결 중 주어진 과목들에 속한 것. extraCondition은 공지 기간 창처럼 상수 조건만
async function linkedIds(connection, kind, { userId, courseIds, extraCondition = '', extraParams = [] }) {
  const { table, linkTable, column } = KINDS[kind]
  const [rows] = await connection.query(
    `SELECT l.${column} AS id FROM ${linkTable} l JOIN ${table} t ON t.id = l.${column}
     WHERE l.user_id = ? AND t.course_id IN (?) ${extraCondition}`,
    [userId, courseIds, ...extraParams],
  )
  return rows.map((row) => row.id)
}

async function unlink(connection, kind, userId, ids) {
  if (ids.length > 0) {
    const { linkTable, column } = KINDS[kind]
    await connection.query(`DELETE FROM ${linkTable} WHERE user_id = ? AND ${column} IN (?)`, [userId, ids])
  }
}

// 활성 수강에서 빠진 과목: 그 과목의 연결(과제 · 공지)과 수강 행을 지운다. 지운 연결 id를 돌려준다.
async function syncEnrollments({ connection, userId }, courseIds) {
  const [rows] = await connection.execute('SELECT course_id FROM enrollments WHERE user_id = ?', [userId])
  const current = rows.map((row) => row.course_id)
  const added = courseIds.filter((id) => !current.includes(id))
  const dropped = current.filter((id) => !courseIds.includes(id))
  if (added.length > 0) {
    await connection.query('INSERT INTO enrollments (user_id, course_id) VALUES ?', [added.map((id) => [userId, id])])
  }
  const removed = { assignment: [], announcement: [] }
  if (dropped.length > 0) {
    for (const kind of Object.keys(KINDS)) {
      removed[kind] = await linkedIds(connection, kind, { userId, courseIds: dropped })
      await unlink(connection, kind, userId, removed[kind])
    }
    await connection.query('DELETE FROM enrollments WHERE user_id = ? AND course_id IN (?)', [userId, dropped])
  }
  return removed
}

async function syncAssignments({ connection, userId }, courseId, assignments) {
  let ids = new Map()
  if (assignments.length > 0) {
    await connection.query(UPSERT_ASSIGNMENTS, [assignments.map((a) => [courseId, a.canvasId, a.title, a.htmlUrl, a.contentHash])])
    ids = await idsByCanvasId(connection, 'assignment', courseId, assignments.map((a) => a.canvasId))
    await connection.query(UPSERT_USER_ASSIGNMENTS, [assignments.map((a) => [userId, ids.get(a.canvasId), a.dueAt])])
  }
  const keep = new Set(ids.values())
  const stale = (await linkedIds(connection, 'assignment', { userId, courseIds: [courseId] })).filter((id) => !keep.has(id))
  await unlink(connection, 'assignment', userId, stale)
  return stale
}

// 공지는 기간 창 밖이라 안 온 것을 "사라짐"으로 보지 않는다: 창 안(또는 게시 시각 없음)의 연결만 비교한다
async function syncAnnouncements({ connection, userId }, courseId, announcements, windowStart) {
  let ids = new Map()
  if (announcements.length > 0) {
    const rows = announcements.map((a) => [courseId, a.canvasId, a.title, a.body, a.htmlUrl, a.postedAt, a.contentHash])
    await connection.query(UPSERT_ANNOUNCEMENTS, [rows])
    ids = await idsByCanvasId(connection, 'announcement', courseId, announcements.map((a) => a.canvasId))
    await connection.query(UPSERT_USER_ANNOUNCEMENTS, [[...ids.values()].map((id) => [userId, id])])
  }
  const keep = new Set(ids.values())
  const inWindow = { extraCondition: 'AND (t.posted_at >= ? OR t.posted_at IS NULL)', extraParams: [windowStart] }
  const stale = (await linkedIds(connection, 'announcement', { userId, courseIds: [courseId], ...inWindow })).filter((id) => !keep.has(id))
  await unlink(connection, 'announcement', userId, stale)
  return stale
}

// 이번에 연결이 끊긴 공유 행 중 아무와도 연결되지 않은 것에 deleted_at을 채운다
async function markOrphans(connection, kind, ids, now) {
  if (ids.length > 0) {
    const { table, linkTable, column } = KINDS[kind]
    await connection.query(
      `UPDATE ${table} t SET t.deleted_at = ? WHERE t.id IN (?) AND t.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ${linkTable} l WHERE l.${column} = t.id)`,
      [now, ids],
    )
  }
}

async function applyCourses(scope, snapshot, courseIds) {
  const removed = await syncEnrollments(scope, [...courseIds.values()])
  for (const course of snapshot.courses) {
    const courseId = courseIds.get(course.canvasCourseId)
    removed.assignment.push(...(await syncAssignments(scope, courseId, course.assignments)))
    removed.announcement.push(...(await syncAnnouncements(scope, courseId, course.announcements, snapshot.announcementWindowStart)))
  }
  return removed
}

export function createLmsSyncRepository(pool, { logger }) {
  // 결과: true(반영함) | false(동기화하는 사이 토큰 행이 지워졌거나 바뀌어 반영하지 않음)
  function applySnapshot({ userId, tokenEnc, snapshot, now }) {
    return runInTransaction({ pool, logger }, async (connection) => {
      const [tokens] = await connection.execute('SELECT token_enc FROM lms_tokens WHERE user_id = ? FOR UPDATE', [userId])
      if (tokens.length === 0 || tokens[0].token_enc !== tokenEnc) {
        return false
      }
      const courseIds = await upsertCourses(connection, snapshot.courses)
      const removed = await applyCourses({ connection, userId }, snapshot, courseIds)
      for (const kind of Object.keys(KINDS)) {
        await markOrphans(connection, kind, removed[kind], now)
      }
      await connection.execute("UPDATE lms_tokens SET status = 'ok', last_synced_at = ?, last_error_code = NULL WHERE user_id = ?", [now, userId])
      return true
    })
  }

  return { applySnapshot }
}
