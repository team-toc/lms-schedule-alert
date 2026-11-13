// 변경 감지 · 알림 테스트 공용 도구 (ADR 0009). DB의 알림 행을 Canvas id로 읽고, API 테스트용 행을 직접 넣는다.
export const NOTIFICATIONS_PATH = '/api/notifications'
export const readPath = (id) => `${NOTIFICATIONS_PATH}/${id}/read`
export const READ_ALL_PATH = `${NOTIFICATIONS_PATH}/read-all`

// 시계는 2026-11-13T00:00Z에서 시작한다 (lms-context의 createLmsClock)
export const FUTURE_1 = '2026-11-20T14:59:00.000Z'
export const FUTURE_2 = '2026-11-27T14:59:00.000Z'
export const PAST_1 = '2026-11-01T00:00:00.000Z'
export const PAST_2 = '2026-11-05T00:00:00.000Z'

const iso = (value) => value?.toISOString() ?? null

const SELECT_NOTIFICATIONS = `SELECT n.id, n.kind, a.canvas_id AS assignment_canvas_id, an.canvas_id AS announcement_canvas_id,
    n.before_due_at, n.after_due_at, n.before_title, n.after_title, n.detected_at, n.read_at
  FROM notifications n
  LEFT JOIN assignments a ON a.id = n.assignment_id
  LEFT JOIN announcements an ON an.id = n.announcement_id
  WHERE n.user_id = ? ORDER BY n.id`

// 사용자의 알림 전부(감지 순서). target은 'assignment:<Canvas id>' · 'announcement:<Canvas id>'
export async function notificationRows(pool, userId) {
  const [rows] = await pool.query(SELECT_NOTIFICATIONS, [userId])
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    target: r.assignment_canvas_id ? `assignment:${r.assignment_canvas_id}` : `announcement:${r.announcement_canvas_id}`,
    beforeDueAt: iso(r.before_due_at),
    afterDueAt: iso(r.after_due_at),
    beforeTitle: r.before_title,
    afterTitle: r.after_title,
    detectedAt: iso(r.detected_at),
    read: r.read_at !== null,
  }))
}

// 시각 · 읽음 · id를 뺀 변경 내용만 (deepEqual 비교용)
export async function changes(pool, userId) {
  return (await notificationRows(pool, userId)).map(({ id, detectedAt, read, ...rest }) => rest)
}

// 기대값: 적지 않은 전/후 값은 NULL
export function change(kind, target, fields = {}) {
  return { kind, target, beforeDueAt: null, afterDueAt: null, beforeTitle: null, afterTitle: null, ...fields }
}

export async function countNotifications(pool, userId) {
  const sql = userId === undefined ? 'SELECT COUNT(*) AS n FROM notifications' : 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?'
  const [[row]] = await pool.query(sql, userId === undefined ? [] : [userId])
  return Number(row.n)
}

// 사용자가 마지막으로 본 값 (Canvas id 순)
export async function seenValues(pool, userId) {
  const [assignments] = await pool.query(
    `SELECT a.canvas_id AS id, ua.seen_title AS title, ua.due_at AS dueAt FROM user_assignments ua
     JOIN assignments a ON a.id = ua.assignment_id WHERE ua.user_id = ? ORDER BY a.canvas_id`,
    [userId],
  )
  const [announcements] = await pool.query(
    `SELECT n.canvas_id AS id, un.seen_title AS title, un.seen_content_hash AS hash FROM user_announcements un
     JOIN announcements n ON n.id = un.announcement_id WHERE un.user_id = ? ORDER BY n.canvas_id`,
    [userId],
  )
  return {
    assignments: assignments.map((r) => ({ id: Number(r.id), title: r.title, dueAt: iso(r.dueAt) })),
    announcements: announcements.map((r) => ({ id: Number(r.id), title: r.title, hash: r.hash })),
  }
}

export async function sharedId(pool, table, canvasId) {
  const [[row]] = await pool.query('SELECT id FROM ?? WHERE canvas_id = ?', [table, canvasId])
  return row.id
}

const toDate = (value) => (value ? new Date(value) : null)

// API 테스트용: 알림 행을 직접 넣는다 (감지 로직과 떼어 목록 · 커서 · 읽음만 본다)
export async function insertNotification(pool, { userId, kind = 'assignment_due_changed', assignmentId = null, announcementId = null, values = {}, detectedAt, readAt }) {
  const { beforeDueAt, afterDueAt, beforeTitle = null, afterTitle = null } = values
  const [result] = await pool.execute(
    `INSERT INTO notifications (user_id, kind, assignment_id, announcement_id, before_due_at, after_due_at, before_title, after_title, detected_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, kind, assignmentId, announcementId, toDate(beforeDueAt), toDate(afterDueAt), beforeTitle, afterTitle, toDate(detectedAt ?? '2026-11-13T00:00:00.000Z'), toDate(readAt)],
  )
  return result.insertId
}

export const encodeCursor = (text) => Buffer.from(text).toString('base64url')
