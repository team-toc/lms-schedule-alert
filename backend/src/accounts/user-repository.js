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

export function createUserRepository(pool) {
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
      await connection.rollback()
      if (err.errno === DUPLICATE_KEY_ERRNO) {
        throw new DuplicateIdentityError({ cause: err })
      }
      throw err
    } finally {
      connection.release()
    }
  }

  return { findUserById, findUserByIdentity, createUserWithIdentity }
}
