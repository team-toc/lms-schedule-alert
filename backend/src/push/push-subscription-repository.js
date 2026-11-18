// 브라우저 푸시 구독 저장소 (경계 레이어, ADR 0012). 구독은 암호문(subscription_enc) · HMAC(endpoint_hash)만 다룬다(원문 없음).
// endpoint 하나에 한 행: 같은 endpoint를 다시 등록하면 그 행을 고친다(다른 사용자가 등록하면 주인이 바뀜).
// 사용자당 상한은 등록 트랜잭션에서 users 행을 잠근 뒤 맞춘다(동시 등록에도 넘지 않게).
import { runInTransaction } from '../db/transaction.js'

// 주인이 바뀌면 성공 기록도 지운다(last_success_at을 먼저 계산: MariaDB는 SET을 왼쪽부터 적용해 뒤 칸은 바뀐 user_id를 봄).
// 연속 실패는 새 구독 값이라 0부터
const UPSERT = `INSERT INTO push_subscriptions (user_id, endpoint_hash, subscription_enc) VALUES (?, ?, ?)
  ON DUPLICATE KEY UPDATE
    last_success_at = IF(user_id = VALUES(user_id), last_success_at, NULL),
    user_id = VALUES(user_id),
    subscription_enc = VALUES(subscription_enc),
    consecutive_failures = 0,
    last_failure_code = NULL`
// 같은 사용자 안에서 가장 오래 성공 못 한 것부터(마지막 성공 → 없으면 만든 시각, 같으면 id)
const OVER_LIMIT = `SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint_hash <> ?
  ORDER BY COALESCE(last_success_at, created_at), id`

export function createPushSubscriptionRepository(pool, { logger }) {
  return {
    // 결과: 'created' | 'updated'. max를 넘으면 같은 사용자의 오래된 구독을 지운다(방금 넣은 것은 빼고)
    upsert({ userId, endpointHash, subscriptionEnc, max }) {
      return runInTransaction({ pool, logger }, async (connection) => {
        await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId])
        const [result] = await connection.execute(UPSERT, [userId, endpointHash, subscriptionEnc])
        const [others] = await connection.execute(OVER_LIMIT, [userId, endpointHash])
        const excess = others.length - (max - 1)
        if (excess > 0) {
          await connection.query('DELETE FROM push_subscriptions WHERE id IN (?) AND user_id = ?', [others.slice(0, excess).map((r) => r.id), userId])
        }
        return result.affectedRows === 1 ? 'created' : 'updated'
      })
    },

    // 내 구독만 지운다. 결과: 지웠는지
    async deleteMine({ userId, endpointHash }) {
      const [result] = await pool.execute('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?', [endpointHash, userId])
      return result.affectedRows > 0
    },
  }
}
