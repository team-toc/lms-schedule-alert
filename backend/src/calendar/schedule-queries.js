// 일정 조회 (경계 레이어, ADR 0010): 기간 안의 내 일정(앱 · 외부), 겹침 후보. 항상 user_id로 거르고
// 지운 일정(deleted_at) · 취소 상태는 뺀다. 기간 [from, to): 구간 일정은 start < to && end > from, 길이 0은 from <= 시각 < to.
const SELECT_IN_RANGE = `SELECT * FROM schedules
  WHERE user_id = ? AND deleted_at IS NULL AND status <> 'cancelled' AND start_at < ?
    AND (end_at > ? OR (start_at = end_at AND start_at >= ?))
  ORDER BY start_at, id`

// 겹침 후보: 하루 종일 · 길이 0 일정은 뺀다(ADR 0010 b · 리뷰 결정 7)
const SELECT_CONFLICT_CANDIDATES = `SELECT id, source, title, start_at, end_at FROM schedules
  WHERE user_id = ? AND deleted_at IS NULL AND status <> 'cancelled' AND is_all_day = FALSE AND end_at > start_at
    AND start_at < ? AND end_at > ?
  ORDER BY start_at, id`

export function createScheduleQueries(pool) {
  async function listInRange(userId, { from, to }) {
    const [rows] = await pool.execute(SELECT_IN_RANGE, [userId, to, from, from])
    return rows
  }

  async function listConflictCandidates(userId, { from, to }) {
    const [rows] = await pool.execute(SELECT_CONFLICT_CANDIDATES, [userId, to, from])
    return rows.map((row) => ({ source: row.source, id: row.id, title: row.title, startAt: row.start_at, endAt: row.end_at }))
  }

  return { listInRange, listConflictCandidates }
}
