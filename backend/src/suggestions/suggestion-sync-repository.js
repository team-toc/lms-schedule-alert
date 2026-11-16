// 제안 단계의 저장소 (ADR 0011). 공지 하나의 제안 갱신 + 훑은 기록을 한 트랜잭션으로.
// 대기(pending) 제안만 바꾸거나 지운다: 수락 · 거절한 제안은 그대로(만든 일정도 건드리지 않음)
import { runInTransaction } from '../db/transaction.js'

// 내 연결이 있는 공지 + 마지막으로 훑은 내용 해시
const SCAN_TARGETS = `SELECT a.id, a.title, a.body, a.posted_at, a.content_hash, s.content_hash AS scanned_hash
  FROM user_announcements l
  JOIN announcements a ON a.id = l.announcement_id
  LEFT JOIN announcement_scans s ON s.user_id = l.user_id AND s.announcement_id = l.announcement_id
  WHERE l.user_id = ? AND a.deleted_at IS NULL
  ORDER BY a.id`
// 내 목록에서 사라진 공지: 대기 제안 · 훑은 기록을 지운다(다시 연결되면 처음부터 훑음)
const DELETE_UNLINKED_PENDING = `DELETE s FROM suggestions s
  LEFT JOIN user_announcements l ON l.user_id = s.user_id AND l.announcement_id = s.announcement_id
  WHERE s.user_id = ? AND s.status = 'pending' AND l.announcement_id IS NULL`
const DELETE_UNLINKED_SCANS = `DELETE s FROM announcement_scans s
  LEFT JOIN user_announcements l ON l.user_id = s.user_id AND l.announcement_id = s.announcement_id
  WHERE s.user_id = ? AND l.announcement_id IS NULL`
const LOCK_EXISTING = 'SELECT id, candidate_key, kind, context, status FROM suggestions WHERE user_id = ? AND announcement_id = ? FOR UPDATE'
const INSERT_SUGGESTIONS = 'INSERT INTO suggestions (user_id, announcement_id, candidate_key, kind, start_at, end_at, is_all_day, context) VALUES ?'
const UPDATE_PENDING = "UPDATE suggestions SET kind = ?, context = ? WHERE id = ? AND status = 'pending'"
const DELETE_PENDING = "DELETE FROM suggestions WHERE id IN (?) AND status = 'pending'"
const UPSERT_SCAN = `INSERT INTO announcement_scans (user_id, announcement_id, content_hash, scanned_at) VALUES (?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE content_hash = VALUES(content_hash), scanned_at = VALUES(scanned_at)`

// 있는 제안과 새 후보를 비교: 새 키는 넣고, 대기 제안은 종류 · 맥락만 새 값으로, 후보에서 빠진 대기 제안은 지운다
function planChanges(existing, candidates) {
  const byKey = new Map(existing.map((row) => [row.candidate_key, row]))
  const keys = new Set(candidates.map((c) => c.key))
  const inserts = candidates.filter((c) => !byKey.has(c.key))
  const updates = candidates
    .map((c) => ({ candidate: c, row: byKey.get(c.key) }))
    .filter(({ candidate, row }) => row?.status === 'pending' && (row.kind !== candidate.kind || row.context !== candidate.context))
  const deletes = existing.filter((row) => row.status === 'pending' && !keys.has(row.candidate_key)).map((row) => row.id)
  return { inserts, updates, deletes }
}

async function writeChanges(connection, { userId, announcementId }, { inserts, updates, deletes }) {
  if (inserts.length > 0) {
    const rows = inserts.map((c) => [userId, announcementId, c.key, c.kind, c.startAt, c.endAt, c.isAllDay, c.context])
    await connection.query(INSERT_SUGGESTIONS, [rows])
  }
  for (const { candidate, row } of updates) {
    await connection.execute(UPDATE_PENDING, [candidate.kind, candidate.context, row.id])
  }
  if (deletes.length > 0) {
    await connection.query(DELETE_PENDING, [deletes])
  }
}

export function createSuggestionSyncRepository(pool, { logger }) {
  return {
    async listScanTargets(userId) {
      const [rows] = await pool.execute(SCAN_TARGETS, [userId])
      return rows
    },

    // → 지운 대기 제안 수
    async removeUnlinked(userId) {
      const [result] = await pool.execute(DELETE_UNLINKED_PENDING, [userId])
      await pool.execute(DELETE_UNLINKED_SCANS, [userId])
      return result.affectedRows
    },

    // → { created, updated, removed }
    async applyCandidates({ userId, announcementId, contentHash, at }, candidates) {
      return runInTransaction({ pool, logger }, async (connection) => {
        const [existing] = await connection.execute(LOCK_EXISTING, [userId, announcementId])
        const changes = planChanges(existing, candidates)
        await writeChanges(connection, { userId, announcementId }, changes)
        await connection.execute(UPSERT_SCAN, [userId, announcementId, contentHash, at])
        return { created: changes.inserts.length, updated: changes.updates.length, removed: changes.deletes.length }
      })
    },
  }
}
