// 일정 저장소 (경계 레이어, ADR 0010). 앱 자체 일정의 만들기 · 수정 · 삭제와 내 일정 하나 읽기.
// 모든 조회 · 변경은 user_id로 거른다. 수정 · 삭제는 source = 'app'인 행만 바꾼다(외부 일정은 동기화만 바꾼다).
const SELECT_MINE = 'SELECT * FROM schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL'

export function createScheduleRepository(pool) {
  async function findMine(userId, id) {
    const [rows] = await pool.execute(SELECT_MINE, [id, userId])
    return rows[0] ?? null
  }

  async function createAppSchedule(userId, { title, startAt, endAt, isAllDay }) {
    const [result] = await pool.execute(
      "INSERT INTO schedules (user_id, source, title, start_at, end_at, is_all_day) VALUES (?, 'app', ?, ?, ?, ?)",
      [userId, title, startAt, endAt, isAllDay],
    )
    return findMine(userId, result.insertId)
  }

  // 결과: 바뀐 행 | null(그 사이 지워졌거나 내 앱 일정이 아님)
  async function updateAppSchedule(userId, id, { title, startAt, endAt, isAllDay }) {
    const [result] = await pool.execute(
      "UPDATE schedules SET title = ?, start_at = ?, end_at = ?, is_all_day = ? WHERE id = ? AND user_id = ? AND source = 'app' AND deleted_at IS NULL",
      [title, startAt, endAt, isAllDay, id, userId],
    )
    return result.affectedRows > 0 ? findMine(userId, id) : null
  }

  // 결과: true(지움) | false
  async function deleteAppSchedule(userId, id, now) {
    const [result] = await pool.execute(
      "UPDATE schedules SET deleted_at = ? WHERE id = ? AND user_id = ? AND source = 'app' AND deleted_at IS NULL",
      [now, id, userId],
    )
    return result.affectedRows > 0
  }

  return { findMine, createAppSchedule, updateAppSchedule, deleteAppSchedule }
}
