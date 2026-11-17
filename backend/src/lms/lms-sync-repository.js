// 사용자 한 명의 동기화 결과를 한 트랜잭션으로 반영하는 경계 레이어 (ADR 0008).
// 공유 행(과목 · 과제 · 공지)은 upsert, 사용자 연결은 이번 목록과 비교해 추가 · 삭제한다.
// 연결이 하나도 남지 않은 공유 행은 지우지 않고 deleted_at만 채운다. 표 · 칼럼 이름은 아래 상수만 쓴다(입력값 아님).
// 변경 감지 (ADR 0009): 연결을 바꾸기 전에 사용자가 본 값을 읽어 비교하고, 알림 기록 · 본 값 갱신도 같은 트랜잭션에서 한다.
// 기준 동기화(baseline_required) · 이번에 새로 수강 목록에 나타난 과목은 본 값만 채우고 알리지 않는다.
import { runInTransaction } from '../db/transaction.js'
import { detectAssignmentChanges, detectAnnouncementChanges } from '../notifications/change-detector.js'
import { writeNotifications } from '../notifications/notification-writer.js'

const KINDS = {
  assignment: { table: 'assignments', linkTable: 'user_assignments', column: 'assignment_id' },
  announcement: { table: 'announcements', linkTable: 'user_announcements', column: 'announcement_id' },
}

const UPSERT_COURSES = 'INSERT INTO courses (canvas_course_id, name) VALUES ? ON DUPLICATE KEY UPDATE name = VALUES(name)'
// 값이 같으면 행이 바뀌지 않아 updated_at도 그대로다(다시 동기화해도 멱등)
const UPSERT_ASSIGNMENTS = `INSERT INTO assignments (course_id, canvas_id, title, html_url, content_hash) VALUES ?
  ON DUPLICATE KEY UPDATE title = VALUES(title), html_url = VALUES(html_url), content_hash = VALUES(content_hash), deleted_at = NULL`
const UPSERT_USER_ASSIGNMENTS = `INSERT INTO user_assignments (user_id, assignment_id, due_at, seen_title) VALUES ?
  ON DUPLICATE KEY UPDATE due_at = VALUES(due_at), seen_title = VALUES(seen_title)`
const UPSERT_ANNOUNCEMENTS = `INSERT INTO announcements (course_id, canvas_id, title, body, html_url, posted_at, content_hash) VALUES ?
  ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body), html_url = VALUES(html_url), posted_at = VALUES(posted_at),
    content_hash = VALUES(content_hash), deleted_at = NULL`
// INSERT IGNORE는 외래키 오류까지 경고로 숨기므로 쓰지 않는다. 이미 있으면 본 값만 바꾼다
const UPSERT_USER_ANNOUNCEMENTS = `INSERT INTO user_announcements (user_id, announcement_id, seen_title, seen_content_hash) VALUES ?
  ON DUPLICATE KEY UPDATE seen_title = VALUES(seen_title), seen_content_hash = VALUES(seen_content_hash)`
// 이번 동기화 전 이 과목에서 사용자가 본 값 (연결 id → 값)
const SEEN_ASSIGNMENTS = `SELECT l.assignment_id AS id, l.due_at, l.seen_title FROM user_assignments l
  JOIN assignments t ON t.id = l.assignment_id WHERE l.user_id = ? AND t.course_id = ?`
const SEEN_ANNOUNCEMENTS = `SELECT l.announcement_id AS id, l.seen_title, l.seen_content_hash FROM user_announcements l
  JOIN announcements t ON t.id = l.announcement_id WHERE l.user_id = ? AND t.course_id = ?`

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

// 활성 수강에서 빠진 과목: 그 과목의 연결(과제 · 공지)과 수강 행을 지운다. 지운 연결 id와 새로 생긴 수강(과목 id)을 돌려준다.
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
  return { removed, added: new Set(added) }
}

async function seenAssignments(connection, userId, courseId) {
  const [rows] = await connection.query(SEEN_ASSIGNMENTS, [userId, courseId])
  return new Map(rows.map((row) => [row.id, { dueAt: row.due_at, title: row.seen_title }]))
}

async function seenAnnouncements(connection, userId, courseId) {
  const [rows] = await connection.query(SEEN_ANNOUNCEMENTS, [userId, courseId])
  return new Map(rows.map((row) => [row.id, { title: row.seen_title, contentHash: row.seen_content_hash }]))
}

// scope.changes에 감지한 변경을 모은다(detect가 거짓이면 본 값만 채움)
async function syncAssignments(scope, { courseId, detect }, assignments) {
  const { connection, userId } = scope
  const seen = await seenAssignments(connection, userId, courseId)
  let ids = new Map()
  if (assignments.length > 0) {
    await connection.query(UPSERT_ASSIGNMENTS, [assignments.map((a) => [courseId, a.canvasId, a.title, a.htmlUrl, a.contentHash])])
    ids = await idsByCanvasId(connection, 'assignment', courseId, assignments.map((a) => a.canvasId))
    await connection.query(UPSERT_USER_ASSIGNMENTS, [assignments.map((a) => [userId, ids.get(a.canvasId), a.dueAt, a.title])])
  }
  const keep = new Set(ids.values())
  const stale = [...seen.keys()].filter((id) => !keep.has(id))
  await unlink(connection, 'assignment', userId, stale)
  if (detect) {
    const current = assignments.map((a) => ({ id: ids.get(a.canvasId), title: a.title, dueAt: a.dueAt }))
    scope.changes.push(...detectAssignmentChanges({ seen, current, removedIds: stale, now: scope.now }))
  }
  return stale
}

// 공지는 기간 창 밖이라 안 온 것을 "사라짐"으로 보지 않는다: 창 안(또는 게시 시각 없음)의 연결만 비교한다
async function syncAnnouncements(scope, { courseId, detect }, announcements, windowStart) {
  const { connection, userId } = scope
  const seen = detect ? await seenAnnouncements(connection, userId, courseId) : new Map()
  let ids = new Map()
  if (announcements.length > 0) {
    const rows = announcements.map((a) => [courseId, a.canvasId, a.title, a.body, a.htmlUrl, a.postedAt, a.contentHash])
    await connection.query(UPSERT_ANNOUNCEMENTS, [rows])
    ids = await idsByCanvasId(connection, 'announcement', courseId, announcements.map((a) => a.canvasId))
    await connection.query(UPSERT_USER_ANNOUNCEMENTS, [announcements.map((a) => [userId, ids.get(a.canvasId), a.title, a.contentHash])])
  }
  if (detect) {
    const current = announcements.map((a) => ({ id: ids.get(a.canvasId), title: a.title, contentHash: a.contentHash }))
    scope.changes.push(...detectAnnouncementChanges({ seen, current }))
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

// 수강에서 빠진 과목의 "사라짐"은 알리지 않는다(syncEnrollments가 감지 없이 연결만 지움)
async function applyCourses(scope, snapshot, courseIds) {
  const { removed, added } = await syncEnrollments(scope, [...courseIds.values()])
  for (const course of snapshot.courses) {
    const courseId = courseIds.get(course.canvasCourseId)
    const target = { courseId, detect: scope.detect && !added.has(courseId) }
    removed.assignment.push(...(await syncAssignments(scope, target, course.assignments)))
    removed.announcement.push(...(await syncAnnouncements(scope, target, course.announcements, snapshot.announcementWindowStart)))
  }
  return removed
}

export function createLmsSyncRepository(pool, { logger }) {
  // 결과: { notifications: 기록한 알림 수 } | null(동기화하는 사이 토큰 행이 지워졌거나 바뀌어 반영하지 않음)
  function applySnapshot({ userId, tokenEnc, snapshot, now }) {
    return runInTransaction({ pool, logger }, async (connection) => {
      const [tokens] = await connection.execute('SELECT token_enc, baseline_required FROM lms_tokens WHERE user_id = ? FOR UPDATE', [userId])
      if (tokens.length === 0 || tokens[0].token_enc !== tokenEnc) {
        return null
      }
      const scope = { connection, userId, now, detect: !tokens[0].baseline_required, changes: [] }
      const courseIds = await upsertCourses(connection, snapshot.courses)
      const removed = await applyCourses(scope, snapshot, courseIds)
      for (const kind of Object.keys(KINDS)) {
        await markOrphans(connection, kind, removed[kind], now)
      }
      const notifications = await writeNotifications(connection, { userId, changes: scope.changes, now })
      await connection.execute(
        "UPDATE lms_tokens SET status = 'ok', baseline_required = FALSE, last_synced_at = ?, last_error_code = NULL WHERE user_id = ?",
        [now, userId],
      )
      return { notifications }
    })
  }

  return { applySnapshot }
}
