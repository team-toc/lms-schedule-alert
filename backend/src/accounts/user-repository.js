// users · auth_identities · password_credentials 테이블 접근만 담당하는 경계 레이어
import { runInTransaction as runDbTransaction } from '../db/transaction.js'

const DUPLICATE_KEY_ERRNO = 1062
const EMAIL_PROVIDER = 'email'

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

// 중복 키(동시 가입 등)만 DuplicateIdentityError로 바꾸고, 그 밖의 에러는 원래 에러를 올린다.
// 롤백 · 연결 정리는 공용 트랜잭션 실행기가 한다 (ADR 0004).
async function runInTransaction(deps, work) {
  try {
    return await runDbTransaction(deps, work)
  } catch (err) {
    if (err.errno === DUPLICATE_KEY_ERRNO) {
      throw new DuplicateIdentityError({ cause: err })
    }
    throw err
  }
}

async function insertUserAndIdentity(connection, { provider, providerUserId, displayName }) {
  const [user] = await connection.execute('INSERT INTO users (display_name) VALUES (?)', [displayName])
  const [identity] = await connection.execute(
    'INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, ?, ?)',
    [user.insertId, provider, providerUserId],
  )
  return { userId: user.insertId, identityId: identity.insertId }
}

const SELECT_USER_BY_ID = `SELECT ${SELECT_USER_COLUMNS} FROM users u WHERE u.id = ?`

const SELECT_EMAIL_CREDENTIAL = `SELECT ${SELECT_USER_COLUMNS}, pc.password_hash
  FROM auth_identities ai
  JOIN users u ON u.id = ai.user_id
  JOIN password_credentials pc ON pc.identity_id = ai.id
  WHERE ai.provider = ? AND ai.provider_user_id = ?`

// provider가 email인 로그인 수단만 본다. 결과: { user, passwordHash } 또는 null
async function selectEmailCredential(pool, email) {
  const [rows] = await pool.execute(SELECT_EMAIL_CREDENTIAL, [EMAIL_PROVIDER, email])
  return rows.length > 0 ? { user: toUser(rows[0]), passwordHash: rows[0].password_hash } : null
}

export function createUserRepository(pool, { logger }) {
  const transactionDeps = { pool, logger }

  function findUserById(id) {
    return selectOne(pool, SELECT_USER_BY_ID, [id])
  }

  function findUserByIdentity({ provider, providerUserId }) {
    const sql = `SELECT ${SELECT_USER_COLUMNS}
      FROM auth_identities ai JOIN users u ON u.id = ai.user_id
      WHERE ai.provider = ? AND ai.provider_user_id = ?`
    return selectOne(pool, sql, [provider, providerUserId])
  }

  // 사용자와 로그인 수단을 한 트랜잭션으로 만든다.
  // 중복 키면 롤백 후 DuplicateIdentityError. 재조회는 호출한 쪽이 트랜잭션 밖에서 한다.
  function createUserWithIdentity({ provider, providerUserId, displayName }) {
    return runInTransaction(transactionDeps, async (connection) => {
      const { userId } = await insertUserAndIdentity(connection, { provider, providerUserId, displayName })
      return selectOne(connection, SELECT_USER_BY_ID, [userId])
    })
  }

  // 이메일 가입: 사용자 · 이메일 로그인 수단 · 비밀번호 해시를 한 트랜잭션으로 만든다 (중복 이메일이면 DuplicateIdentityError)
  function createUserWithPassword({ email, displayName, passwordHash }) {
    return runInTransaction(transactionDeps, async (connection) => {
      const { userId, identityId } = await insertUserAndIdentity(connection, {
        provider: EMAIL_PROVIDER,
        providerUserId: email,
        displayName,
      })
      await connection.execute('INSERT INTO password_credentials (identity_id, password_hash) VALUES (?, ?)', [
        identityId,
        passwordHash,
      ])
      return selectOne(connection, SELECT_USER_BY_ID, [userId])
    })
  }

  const findEmailCredential = (email) => selectEmailCredential(pool, email)

  return { findUserById, findUserByIdentity, createUserWithIdentity, createUserWithPassword, findEmailCredential }
}
