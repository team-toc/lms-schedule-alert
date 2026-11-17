// 외부 캘린더 연결 저장소 (경계 레이어, ADR 0010). 링크는 암호문(url_enc) · HMAC(url_hash)만 다룬다(원문 없음).
// 모든 조회 · 변경은 user_id로 거른다. 사용자당 개수 상한은 등록 트랜잭션에서 users 행을 잠근 뒤 센다(동시 등록에도 넘지 않게).
import { runInTransaction } from '../db/transaction.js'

const DUPLICATE_KEY_ERRNO = 1062
const SELECT_PUBLIC = 'SELECT id, provider, sync_status, last_synced_at, last_error_code, created_at FROM calendar_links'

const toLink = (row) => ({
  id: row.id,
  provider: row.provider,
  syncStatus: row.sync_status,
  lastSyncedAt: row.last_synced_at,
  lastErrorCode: row.last_error_code,
  createdAt: row.created_at,
})

async function countAndDuplicate(executor, userId, urlHash) {
  const [[row]] = await executor.execute(
    'SELECT COUNT(*) AS total, COALESCE(SUM(url_hash = ?), 0) AS same FROM calendar_links WHERE user_id = ?',
    [urlHash, userId],
  )
  return { total: Number(row.total), duplicate: Number(row.same) > 0 }
}

// 결과: null(등록 가능) | 'duplicate' | 'limit'
function admission({ total, duplicate }, max) {
  if (duplicate) return 'duplicate'
  return total >= max ? 'limit' : null
}

// 결과: { id } | { error: 'duplicate' | 'limit' }
function insertLink({ pool, logger }, { userId, provider, urlEnc, urlHash, max }) {
  return runInTransaction({ pool, logger }, async (connection) => {
    await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId])
    const rejected = admission(await countAndDuplicate(connection, userId, urlHash), max)
    if (rejected) {
      return { error: rejected }
    }
    try {
      const [result] = await connection.execute('INSERT INTO calendar_links (user_id, provider, url_enc, url_hash) VALUES (?, ?, ?, ?)', [userId, provider, urlEnc, urlHash])
      return { id: result.insertId }
    } catch (err) {
      if (err.errno === DUPLICATE_KEY_ERRNO) return { error: 'duplicate' }
      throw err
    }
  })
}

// 연결과 그 연결의 일정을 한 트랜잭션으로 지운다(FK CASCADE도 있지만 명시적으로). 결과: 지웠으면 true
function deleteLink({ pool, logger }, userId, id) {
  return runInTransaction({ pool, logger }, async (connection) => {
    const [links] = await connection.execute('SELECT id FROM calendar_links WHERE id = ? AND user_id = ? FOR UPDATE', [id, userId])
    if (links.length === 0) {
      return false
    }
    await connection.execute('DELETE FROM schedules WHERE calendar_link_id = ? AND user_id = ?', [id, userId])
    await connection.execute('DELETE FROM calendar_links WHERE id = ? AND user_id = ?', [id, userId])
    return true
  })
}

export function createCalendarLinkRepository(pool, { logger }) {
  // 받아 보기 전에 싸게 걸러 내기(잠금 없음). 최종 판단은 insertLink
  async function checkAdmission(userId, urlHash, max) {
    return admission(await countAndDuplicate(pool, userId, urlHash), max)
  }

  async function listLinks(userId) {
    const [rows] = await pool.execute(`${SELECT_PUBLIC} WHERE user_id = ? ORDER BY id`, [userId])
    return rows.map(toLink)
  }

  async function findLink(userId, id) {
    const [rows] = await pool.execute(`${SELECT_PUBLIC} WHERE id = ? AND user_id = ?`, [id, userId])
    return rows[0] ? toLink(rows[0]) : null
  }

  // 동기화할 연결(무효 제외). 암호문은 동기화 안에서만 쓴다
  async function linksToSync(userId) {
    const [rows] = await pool.execute("SELECT id, provider, url_enc FROM calendar_links WHERE user_id = ? AND sync_status <> 'invalid' ORDER BY id", [userId])
    return rows.map((row) => ({ id: row.id, provider: row.provider, urlEnc: row.url_enc }))
  }

  // 실패 기록. 그 사이 링크가 지워졌거나 바뀌었으면(암호문이 다르면) 아무것도 바꾸지 않는다
  async function recordFailure({ linkId, urlEnc, status, errorCode }) {
    await pool.execute('UPDATE calendar_links SET sync_status = ?, last_error_code = ? WHERE id = ? AND url_enc = ?', [status, errorCode, linkId, urlEnc])
  }

  // 주기 실행 대상: 무효가 아닌 연결이 있는 사용자, 가장 오래전에 동기화한 사용자부터
  async function listSyncTargets() {
    const [rows] = await pool.query(
      `SELECT user_id FROM calendar_links WHERE sync_status <> 'invalid'
       GROUP BY user_id ORDER BY MIN(last_synced_at IS NOT NULL), MIN(last_synced_at), user_id`,
    )
    return rows.map((row) => row.user_id)
  }

  return {
    checkAdmission,
    insertLink: (input) => insertLink({ pool, logger }, input),
    listLinks,
    findLink,
    deleteLink: (userId, id) => deleteLink({ pool, logger }, userId, id),
    linksToSync,
    recordFailure,
    listSyncTargets,
  }
}
