// lms_tokens 접근과 사용자별 동기화 잠금 (경계 레이어, ADR 0008). 토큰 원문은 다루지 않는다(암호문만).
import { runInTransaction } from '../db/transaction.js'

// 다시 등록하면 같은 행을 새 암호문으로 바꾸고 "첫 동기화 전" 상태로 되돌린다
const UPSERT_TOKEN = `INSERT INTO lms_tokens (user_id, token_enc, status, connected_at, last_synced_at, last_error_code)
  VALUES (?, ?, 'syncing', ?, NULL, NULL)
  ON DUPLICATE KEY UPDATE token_enc = VALUES(token_enc), status = 'syncing', connected_at = VALUES(connected_at),
    last_synced_at = NULL, last_error_code = NULL`
// 잠금 이름에 DB 이름을 넣어 같은 MariaDB의 다른 DB(개발 · 테스트)와 겹치지 않게 한다
const GET_SYNC_LOCK = "SELECT GET_LOCK(CONCAT(DATABASE(), ':lms_sync:', ?), 0) AS acquired"
const RELEASE_SYNC_LOCK = "SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':lms_sync:', ?))"
const LOCK_ACQUIRED = 1

function toTokenState(row) {
  return {
    tokenEnc: row.token_enc,
    status: row.status,
    connectedAt: row.connected_at,
    lastSyncedAt: row.last_synced_at,
    lastErrorCode: row.last_error_code,
  }
}

// 잠금 해제가 실패한 연결은 상태를 알 수 없으니 버린다(연결이 끊기면 서버가 잠금을 푼다)
async function releaseLockOrDestroy(connection, userId) {
  try {
    await connection.query(RELEASE_SYNC_LOCK, [userId])
    return true
  } catch {
    connection.destroy()
    return false
  }
}

// 같은 사용자의 동기화가 동시에 돌지 않게 MariaDB GET_LOCK(대기 0초)을 잡고 work를 실행한다.
// 결과: { acquired: false } 또는 { acquired: true, result }. 잠금은 그 연결에 붙어 있어 서버가 죽어도 남지 않는다.
async function withSyncLock(pool, userId, work) {
  const connection = await pool.getConnection()
  let reusable = true
  try {
    const [[{ acquired }]] = await connection.query(GET_SYNC_LOCK, [userId])
    if (Number(acquired) !== LOCK_ACQUIRED) {
      return { acquired: false }
    }
    try {
      return { acquired: true, result: await work() }
    } finally {
      reusable = await releaseLockOrDestroy(connection, userId)
    }
  } finally {
    if (reusable) {
      connection.release()
    }
  }
}

// 연동 해제: 토큰 행을 먼저 지워(행 잠금) 동시에 돌던 동기화가 반영 직전 확인에서 버리게 하고,
// 그 사용자의 수강 · 과제 · 공지 연결만 지운다. 공유 행은 그대로. 결과: 지웠으면 true, 연결이 없었으면 false
function deleteTokenAndLinks({ pool, logger }, userId) {
  return runInTransaction({ pool, logger }, async (connection) => {
    const [deleted] = await connection.execute('DELETE FROM lms_tokens WHERE user_id = ?', [userId])
    if (deleted.affectedRows === 0) {
      return false
    }
    for (const table of ['user_assignments', 'user_announcements', 'enrollments']) {
      await connection.query('DELETE FROM ?? WHERE user_id = ?', [table, userId])
    }
    await connection.execute("UPDATE users SET onboarding_step = 'lms_token' WHERE id = ?", [userId])
    return true
  })
}

export function createLmsTokenRepository(pool, { logger }) {
  async function findToken(userId) {
    const [rows] = await pool.execute(
      'SELECT token_enc, status, connected_at, last_synced_at, last_error_code FROM lms_tokens WHERE user_id = ?',
      [userId],
    )
    return rows.length > 0 ? toTokenState(rows[0]) : null
  }

  // 토큰 저장(교체)과 onboarding 완료를 한 트랜잭션으로
  function saveToken({ userId, tokenEnc, now }) {
    return runInTransaction({ pool, logger }, async (connection) => {
      await connection.execute(UPSERT_TOKEN, [userId, tokenEnc, now])
      await connection.execute("UPDATE users SET onboarding_step = 'done' WHERE id = ?", [userId])
    })
  }

  // 실패 기록. 그 사이 토큰이 지워졌거나 바뀌었으면(암호문이 다르면) 아무것도 바꾸지 않는다.
  async function recordFailure({ userId, tokenEnc, status, errorCode }) {
    await pool.execute('UPDATE lms_tokens SET status = ?, last_error_code = ? WHERE user_id = ? AND token_enc = ?', [
      status,
      errorCode,
      userId,
      tokenEnc,
    ])
  }

  // 주기 실행 대상: needs_reauth(토큰을 다시 등록해야 함)는 뺀다. 가장 오래전에 동기화한 사용자부터
  async function listSyncTargets() {
    const [rows] = await pool.query(
      "SELECT user_id FROM lms_tokens WHERE status <> 'needs_reauth' ORDER BY last_synced_at IS NOT NULL, last_synced_at, user_id",
    )
    return rows.map((row) => row.user_id)
  }

  return {
    findToken,
    saveToken,
    recordFailure,
    deleteToken: (userId) => deleteTokenAndLinks({ pool, logger }, userId),
    listSyncTargets,
    withSyncLock: (userId, work) => withSyncLock(pool, userId, work),
  }
}
