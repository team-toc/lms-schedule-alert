// users · auth_identities 테이블 접근만 담당하는 경계 레이어
const DUPLICATE_KEY_ERRNO = 1062

const SELECT_USER_COLUMNS = 'u.id, u.display_name, u.onboarding_step'

export class DuplicateIdentityError extends Error {
  constructor(options) {
    super('이미 등록된 로그인 수단', options)
    this.name = 'DuplicateIdentityError'
  }
}

function toUser(row) {
  return { id: row.id, displayName: row.display_name, onboardingStep: row.onboarding_step }
}

async function selectOne(executor, sql, params) {
  const [rows] = await executor.execute(sql, params)
  return rows.length > 0 ? toUser(rows[0]) : null
}

// 에러에서 원인 파악에 필요한 것만 꺼낸다 (SQL 값 등은 남기지 않음)
function describeError(err) {
  return { name: err.name, code: err.code, errno: err.errno, message: err.message }
}

// 롤백에 실패한 연결은 상태를 알 수 없으므로 풀에 돌려주지 않고 버린다.
// 버린 연결은 서버가 끊으면서 열린 트랜잭션을 롤백한다. 반환값: 연결을 다시 써도 되는지
async function rollbackOrDestroy(connection, { logger, originalError }) {
  try {
    await connection.rollback()
    return true
  } catch (rollbackError) {
    logger.error(
      {
        event: 'transaction_rollback_failed',
        rollbackError: describeError(rollbackError),
        originalError: describeError(originalError),
      },
      'transaction rollback failed, connection destroyed',
    )
    connection.destroy()
    return false
  }
}

export function createUserRepository(pool, { logger }) {
  function findUserById(id) {
    return selectOne(pool, `SELECT ${SELECT_USER_COLUMNS} FROM users u WHERE u.id = ?`, [id])
  }

  function findUserByIdentity({ provider, providerUserId }) {
    const sql = `SELECT ${SELECT_USER_COLUMNS}
      FROM auth_identities ai JOIN users u ON u.id = ai.user_id
      WHERE ai.provider = ? AND ai.provider_user_id = ?`
    return selectOne(pool, sql, [provider, providerUserId])
  }

  // 사용자와 로그인 수단을 한 트랜잭션으로 만든다.
  // 중복 키면 롤백 후 DuplicateIdentityError. 재조회는 호출한 쪽이 트랜잭션 밖에서 한다.
  async function createUserWithIdentity({ provider, providerUserId, displayName }) {
    const connection = await pool.getConnection()
    let reusable = true
    try {
      await connection.beginTransaction()
      const [inserted] = await connection.execute('INSERT INTO users (display_name) VALUES (?)', [displayName])
      await connection.execute(
        'INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, ?, ?)',
        [inserted.insertId, provider, providerUserId],
      )
      const user = await selectOne(connection, `SELECT ${SELECT_USER_COLUMNS} FROM users u WHERE u.id = ?`, [inserted.insertId])
      await connection.commit()
      return user
    } catch (err) {
      // 롤백이 실패해도 위로는 원래 에러를 올린다 (원인 보존)
      reusable = await rollbackOrDestroy(connection, { logger, originalError: err })
      if (err.errno === DUPLICATE_KEY_ERRNO) {
        throw new DuplicateIdentityError({ cause: err })
      }
      throw err
    } finally {
      if (reusable) {
        connection.release()
      }
    }
  }

  return { findUserById, findUserByIdentity, createUserWithIdentity }
}
