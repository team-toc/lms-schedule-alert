// 제안 API 저장소 (ADR 0011). 모든 조회 · 변경은 user_id 조건으로 내 것만. 수락 · 거절은 제안 행을 잠그고(FOR UPDATE) 한 번만.
import { runInTransaction } from '../db/transaction.js'

// 만든 일정이 지워졌으면(앱 일정 삭제 = deleted_at) live_schedule_id는 null
const ITEM_SELECT = `SELECT s.id, s.kind, s.status, s.start_at, s.end_at, s.is_all_day, s.context, s.created_at, s.decided_at,
    a.title AS announcement_title, a.html_url, c.name AS course_name, sc.id AS live_schedule_id
  FROM suggestions s
  JOIN announcements a ON a.id = s.announcement_id
  JOIN courses c ON c.id = a.course_id
  LEFT JOIN schedules sc ON sc.id = s.schedule_id AND sc.deleted_at IS NULL`
// 지난 대기 제안(만료): 시각 일정은 시작 <= now, 하루 종일은 끝 <= now
const EXPIRED = '((s.is_all_day = 0 AND s.start_at <= ?) OR (s.is_all_day = 1 AND s.end_at <= ?))'

// status별 조건 · 정렬 · 커서
function listSql({ status, after }, now) {
  if (status === 'pending') {
    const cursor = after ? 'AND (s.start_at > ? OR (s.start_at = ? AND s.id > ?))' : ''
    const cursorParams = after ? [after.startAt, after.startAt, after.id] : []
    return { where: `s.status = 'pending' AND NOT ${EXPIRED} ${cursor}`, params: [now, now, ...cursorParams], order: 's.start_at, s.id' }
  }
  const base = status === 'expired' ? `s.status = 'pending' AND ${EXPIRED}` : 's.status = ?'
  const baseParams = status === 'expired' ? [now, now] : [status]
  return { where: `${base} ${after ? 'AND s.id < ?' : ''}`, params: [...baseParams, ...(after ? [after.id] : [])], order: 's.id DESC' }
}

const INSERT_SCHEDULE = "INSERT INTO schedules (user_id, source, title, start_at, end_at, is_all_day) VALUES (?, 'app', ?, ?, ?, ?)"
const MARK_DECIDED = "UPDATE suggestions SET status = ?, schedule_id = ?, decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'"

export function createSuggestionRepository(pool, { logger }) {
  const itemById = async (connection, userId, id) => {
    const [[row]] = await connection.execute(`${ITEM_SELECT} WHERE s.id = ? AND s.user_id = ?`, [id, userId])
    return row ?? null
  }

  return {
    // limit + 1개를 읽어 다음 쪽이 있는지 본다
    async list(userId, query, now) {
      const { where, params, order } = listSql(query, now)
      const [rows] = await pool.query(`${ITEM_SELECT} WHERE s.user_id = ? AND ${where} ORDER BY ${order} LIMIT ?`, [userId, ...params, query.limit + 1])
      return rows
    },

    // decide(row, connection) → { result } | { failure } (실패면 롤백). row: 잠근 제안 + 공지 제목 | null
    async withLockedSuggestion(userId, id, decide) {
      const rollback = new Error('rollback')
      try {
        return await runInTransaction({ pool, logger }, async (connection) => {
          const [[row]] = await connection.execute(
            'SELECT s.*, a.title AS announcement_title FROM suggestions s JOIN announcements a ON a.id = s.announcement_id WHERE s.id = ? AND s.user_id = ? FOR UPDATE',
            [id, userId],
          )
          const outcome = await decide(row ?? null, connection)
          if (outcome.failure) {
            rollback.outcome = outcome
            throw rollback
          }
          return outcome
        })
      } catch (err) {
        if (err === rollback) {
          return err.outcome
        }
        throw err
      }
    },

    async createSchedule(connection, userId, { title, startAt, endAt, isAllDay }) {
      const [result] = await connection.execute(INSERT_SCHEDULE, [userId, title, startAt, endAt, isAllDay])
      return { source: 'app', id: result.insertId, calendar_link_id: null, title, start_at: startAt, end_at: endAt, is_all_day: isAllDay }
    },

    async markDecided(connection, userId, id, { status, scheduleId, at }) {
      await connection.execute(MARK_DECIDED, [status, scheduleId, at, id, userId])
      return itemById(connection, userId, id)
    },
  }
}
