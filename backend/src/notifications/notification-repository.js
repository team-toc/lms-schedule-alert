// 알림 조회 · 읽음 경계 레이어 (ADR 0009). 항상 user_id로 거른다(다른 사용자 알림은 보이지도 바뀌지도 않음).
// 응답에 공지 본문은 넣지 않는다(본문 칼럼을 읽지도 않음). 시각은 UTC ISO.
import { encodeCursor } from './notification-query.js'

const SELECT_LIST = `SELECT n.id, n.kind, n.before_due_at, n.after_due_at, n.before_title, n.after_title, n.detected_at, n.read_at,
    COALESCE(a.title, an.title) AS title, COALESCE(a.html_url, an.html_url) AS html_url, c.name AS course_name
  FROM notifications n
  LEFT JOIN assignments a ON a.id = n.assignment_id
  LEFT JOIN announcements an ON an.id = n.announcement_id
  JOIN courses c ON c.id = COALESCE(a.course_id, an.course_id)
  WHERE n.user_id = ?`

const iso = (date) => (date ? date.toISOString() : null)

// 종류마다 [before, after] 모양. 마감은 { dueAt }, 제목은 { title }, 생김 · 사라짐은 한쪽 null
const SHAPES = {
  assignment_created: (r) => [null, { dueAt: iso(r.after_due_at) }],
  assignment_due_changed: (r) => [{ dueAt: iso(r.before_due_at) }, { dueAt: iso(r.after_due_at) }],
  assignment_title_changed: (r) => [{ title: r.before_title }, { title: r.after_title }],
  assignment_removed: (r) => [{ dueAt: iso(r.before_due_at) }, null],
  announcement_created: () => [null, null],
  announcement_updated: (r) => [{ title: r.before_title }, { title: r.after_title }],
}

function toItem(row) {
  const [before, after] = SHAPES[row.kind](row)
  return {
    id: row.id,
    kind: row.kind,
    courseName: row.course_name,
    title: row.title,
    before,
    after,
    detectedAt: iso(row.detected_at),
    read: row.read_at !== null,
    url: row.html_url,
  }
}

export function createNotificationRepository(pool, { now }) {
  // 최신순(id 내림차순). limit + 1개를 읽어 다음 페이지가 있을 때만 nextCursor
  async function list(userId, { unreadOnly, limit, beforeId }) {
    let sql = SELECT_LIST
    const params = [userId]
    if (unreadOnly) {
      sql += ' AND n.read_at IS NULL'
    }
    if (beforeId !== null) {
      sql += ' AND n.id < ?'
      params.push(beforeId)
    }
    const [rows] = await pool.query(`${sql} ORDER BY n.id DESC LIMIT ?`, [...params, limit + 1])
    const page = rows.slice(0, limit)
    return { notifications: page.map(toItem), nextCursor: rows.length > limit ? encodeCursor(page.at(-1).id) : null }
  }

  // 결과: true(내 알림, 이미 읽었어도) | false(없음 · 다른 사용자). 읽은 시각은 처음 읽을 때만 채운다
  async function markRead(userId, id) {
    await pool.execute('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', [now(), id, userId])
    const [rows] = await pool.execute('SELECT 1 FROM notifications WHERE id = ? AND user_id = ?', [id, userId])
    return rows.length > 0
  }

  async function markAllRead(userId) {
    await pool.execute('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now(), userId])
  }

  return { list, markRead, markAllRead }
}
