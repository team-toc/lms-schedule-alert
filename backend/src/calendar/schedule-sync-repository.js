// 외부 캘린더 일정 반영 (경계 레이어, ADR 0010). 제공자(iCloud · 나중에 Google · 카카오)가 넘긴 NormalizedEvent[]를
// 연결 하나에 대해 한 트랜잭션으로: upsert(값이 같으면 행 그대로 → 멱등) → 목록에 없는 행은 deleted_at → 연결 상태 ok.
// external_id = sha256(제공자 id + 회차 키), content_hash = sha256(제목 · 시각 · 하루 종일 · 상태). 제목 외 내용은 저장하지 않는다.
import { createHash } from 'node:crypto'
import { runInTransaction } from '../db/transaction.js'

const BATCH_SIZE = 500
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const UPSERT_SCHEDULES = `INSERT INTO schedules
  (user_id, calendar_link_id, source, external_id, title, start_at, end_at, is_all_day, status, content_hash) VALUES ?
  ON DUPLICATE KEY UPDATE title = VALUES(title), start_at = VALUES(start_at), end_at = VALUES(end_at), is_all_day = VALUES(is_all_day),
    status = VALUES(status), content_hash = VALUES(content_hash), deleted_at = NULL`

function toRow({ userId, linkId }, event) {
  const contentHash = sha256(JSON.stringify([event.title, event.startAt.toISOString(), event.endAt.toISOString(), event.isAllDay, event.status]))
  return [userId, linkId, event.sourceType, sha256(event.externalId), event.title, event.startAt, event.endAt, event.isAllDay, event.status, contentHash]
}

// 같은 회차 키가 두 번 오면(깨진 피드) 마지막 것만
function uniqueRows(scope, events) {
  const byExternalId = new Map()
  for (const event of events) {
    const row = toRow(scope, event)
    byExternalId.set(row[3], row)
  }
  return [...byExternalId.values()]
}

async function upsertAll(connection, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await connection.query(UPSERT_SCHEDULES, [rows.slice(i, i + BATCH_SIZE)])
  }
}

// 지금 살아 있는 행 중 이번 목록에 없는 것 → deleted_at
async function markRemoved(connection, { linkId, keep, now }) {
  const [rows] = await connection.execute('SELECT id, external_id FROM schedules WHERE calendar_link_id = ? AND deleted_at IS NULL', [linkId])
  const removed = rows.filter((row) => !keep.has(row.external_id)).map((row) => row.id)
  if (removed.length > 0) {
    await connection.query('UPDATE schedules SET deleted_at = ? WHERE id IN (?)', [now, removed])
  }
  return removed.length
}

export function createScheduleSyncRepository(pool, { logger }) {
  // 결과: { events, removed } | null(동기화하는 사이 연결이 지워졌거나 링크가 바뀌어 반영하지 않음)
  function applyLinkEvents({ userId, linkId, urlEnc, events, now }) {
    return runInTransaction({ pool, logger }, async (connection) => {
      const [links] = await connection.execute('SELECT url_enc FROM calendar_links WHERE id = ? AND user_id = ? FOR UPDATE', [linkId, userId])
      if (links.length === 0 || links[0].url_enc !== urlEnc) {
        return null
      }
      const rows = uniqueRows({ userId, linkId }, events)
      await upsertAll(connection, rows)
      const removed = await markRemoved(connection, { linkId, keep: new Set(rows.map((row) => row[3])), now })
      await connection.execute("UPDATE calendar_links SET sync_status = 'ok', last_synced_at = ?, last_error_code = NULL WHERE id = ?", [now, linkId])
      return { events: rows.length, removed }
    })
  }

  return { applyLinkEvents }
}
