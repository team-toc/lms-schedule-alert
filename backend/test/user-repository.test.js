import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { openTestDb } from './helpers/test-db.js'
import { createUserRepository, DuplicateIdentityError } from '../src/accounts/user-repository.js'
import { createAccountService, DISPLAY_NAME_MAX_LENGTH } from '../src/accounts/account-service.js'

const IDENTITY = { provider: 'kakao', providerUserId: '4000000001', displayName: '테스트사용자' }
const silentLogger = pino({ level: 'silent' })

function createCapturingLogger() {
  const entries = []
  const logger = pino({ level: 'trace' }, { write: (line) => entries.push(JSON.parse(line)) })
  return { logger, entries }
}

// INSERT에서 originalError, 롤백에서 rollbackError를 던지는 가짜 연결 · 풀
function createPoolWithBrokenRollback({ originalError, rollbackError }) {
  const connection = {
    released: 0,
    destroyed: 0,
    beginTransaction: async () => {},
    execute: async () => {
      throw originalError
    },
    commit: async () => {},
    rollback: async () => {
      throw rollbackError
    },
    release() {
      this.released += 1
    },
    destroy() {
      this.destroyed += 1
    },
  }
  return { connection, pool: { getConnection: async () => connection } }
}

describe('사용자 저장소: 롤백 실패 처리 (가짜 연결)', () => {
  const originalError = Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
  const rollbackError = Object.assign(new Error('Connection lost: The server closed the connection.'), {
    code: 'PROTOCOL_CONNECTION_LOST',
  })

  it('a) 롤백이 실패해도 원래 에러를 올린다', async () => {
    const { pool } = createPoolWithBrokenRollback({ originalError, rollbackError })
    const repo = createUserRepository(pool, { logger: silentLogger })

    await assert.rejects(repo.createUserWithIdentity(IDENTITY), (err) => err === originalError)
  })

  it('a-1) 원래 에러가 중복 키면 롤백이 실패해도 DuplicateIdentityError(원인 = 원래 에러)', async () => {
    const duplicate = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 })
    const { pool } = createPoolWithBrokenRollback({ originalError: duplicate, rollbackError })
    const repo = createUserRepository(pool, { logger: silentLogger })

    await assert.rejects(repo.createUserWithIdentity(IDENTITY), (err) => {
      assert.ok(err instanceof DuplicateIdentityError)
      assert.equal(err.cause, duplicate)
      return true
    })
  })

  it('b) 롤백이 실패한 연결은 destroy하고 release하지 않는다', async () => {
    const { pool, connection } = createPoolWithBrokenRollback({ originalError, rollbackError })
    const repo = createUserRepository(pool, { logger: silentLogger })

    await assert.rejects(repo.createUserWithIdentity(IDENTITY))

    assert.equal(connection.destroyed, 1)
    assert.equal(connection.released, 0)
  })

  it('c) 롤백 에러를 구조화 로그로 남기고, 입력값(닉네임 · 제공자 id)은 남기지 않는다', async () => {
    const { pool } = createPoolWithBrokenRollback({ originalError, rollbackError })
    const capture = createCapturingLogger()
    const repo = createUserRepository(pool, { logger: capture.logger })

    await assert.rejects(repo.createUserWithIdentity(IDENTITY))

    const entry = capture.entries.find((e) => e.event === 'transaction_rollback_failed')
    assert.ok(entry, '롤백 실패 로그가 있어야 함')
    assert.equal(entry.level, 50)
    assert.equal(entry.rollbackError.code, 'PROTOCOL_CONNECTION_LOST')
    assert.equal(entry.originalError.code, 'ER_LOCK_DEADLOCK')
    const text = JSON.stringify(capture.entries)
    assert.ok(!text.includes(IDENTITY.displayName))
    assert.ok(!text.includes(IDENTITY.providerUserId))
  })
})

describe('MariaDB 사용자 저장소', () => {
  let db
  let repo

  before(async () => {
    db = await openTestDb()
    repo = createUserRepository(db.pool, { logger: silentLogger })
  })
  beforeEach(async () => {
    await db.resetDatabase()
  })
  after(async () => {
    await db.pool.end()
  })

  it('createUserWithIdentity: users · auth_identities를 함께 만들고 사용자를 돌려준다', async () => {
    const user = await repo.createUserWithIdentity(IDENTITY)

    assert.deepEqual(Object.keys(user).sort(), ['displayName', 'id', 'onboardingStep'])
    assert.equal(user.displayName, IDENTITY.displayName)
    assert.equal(user.onboardingStep, 'lms_token')
    assert.equal(await db.countRows('users'), 1)
    assert.equal(await db.countRows('auth_identities'), 1)
  })

  it('findUserByIdentity · findUserById: 만든 사용자를 찾고, 없으면 null', async () => {
    const created = await repo.createUserWithIdentity(IDENTITY)

    assert.deepEqual(await repo.findUserByIdentity(IDENTITY), created)
    assert.deepEqual(await repo.findUserById(created.id), created)
    assert.equal(await repo.findUserByIdentity({ provider: 'kakao', providerUserId: 'nobody' }), null)
    assert.equal(await repo.findUserById(created.id + 1000), null)
  })

  it('같은 로그인 수단을 또 만들면 DuplicateIdentityError, 롤백되어 고아 users 행이 없다', async () => {
    await repo.createUserWithIdentity(IDENTITY)

    await assert.rejects(repo.createUserWithIdentity({ ...IDENTITY, displayName: '두번째' }), DuplicateIdentityError)

    assert.equal(await db.countRows('users'), 1)
    assert.equal(await db.countRows('auth_identities'), 1)
  })

  it('중복 키가 아닌 DB 에러는 원래 에러 그대로 올리고, 트랜잭션은 롤백된다', async () => {
    // provider ENUM에 없는 값 → strict 모드에서 데이터 잘림 에러 (중복 키 아님)
    const invalid = { ...IDENTITY, provider: 'unknown-provider' }

    await assert.rejects(repo.createUserWithIdentity(invalid), (err) => {
      assert.ok(!(err instanceof DuplicateIdentityError))
      assert.equal(err.code, 'WARN_DATA_TRUNCATED')
      return true
    })
    assert.equal(await db.countRows('users'), 0)
  })

  it('실패한 트랜잭션 뒤에도 연결이 풀에 정상 반납되어 다음 요청이 동작한다', async () => {
    for (let i = 0; i < 15; i += 1) {
      await assert.rejects(repo.createUserWithIdentity({ ...IDENTITY, provider: 'unknown-provider' }))
    }

    const user = await repo.createUserWithIdentity(IDENTITY)

    assert.ok(user.id)
  })

  it('계정 로직 + DB: 긴 한글 닉네임이 깨지지 않고 최대 길이로 저장된다', async () => {
    const service = createAccountService({ userRepository: repo })

    await service.loginWithIdentity({ ...IDENTITY, displayName: '한'.repeat(DISPLAY_NAME_MAX_LENGTH + 20) })

    const [[row]] = await db.pool.query('SELECT display_name, CHAR_LENGTH(display_name) AS len FROM users')
    assert.equal(row.display_name, '한'.repeat(DISPLAY_NAME_MAX_LENGTH))
    assert.equal(Number(row.len), DISPLAY_NAME_MAX_LENGTH)
  })

  describe('이메일 계정', () => {
    const EMAIL_INPUT = { email: 'user@example.com', displayName: '이메일사용자', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA' }

    it('createUserWithPassword: users · auth_identities(email) · password_credentials를 한 트랜잭션으로 만든다', async () => {
      const user = await repo.createUserWithPassword(EMAIL_INPUT)

      assert.deepEqual(Object.keys(user).sort(), ['displayName', 'id', 'onboardingStep'])
      const [[row]] = await db.pool.query(
        `SELECT ai.provider, ai.provider_user_id, pc.password_hash, pc.email_verified
         FROM auth_identities ai JOIN password_credentials pc ON pc.identity_id = ai.id WHERE ai.user_id = ?`,
        [user.id],
      )
      assert.deepEqual({ ...row }, { provider: 'email', provider_user_id: EMAIL_INPUT.email, password_hash: EMAIL_INPUT.passwordHash, email_verified: 0 })
    })

    it('같은 이메일 두 번 → DuplicateIdentityError, 롤백되어 users · password_credentials가 늘지 않는다', async () => {
      await repo.createUserWithPassword(EMAIL_INPUT)

      await assert.rejects(repo.createUserWithPassword({ ...EMAIL_INPUT, displayName: '두번째' }), DuplicateIdentityError)

      assert.equal(await db.countRows('users'), 1)
      assert.equal(await db.countRows('password_credentials'), 1)
    })

    it('비밀번호 행 생성이 실패하면(NOT NULL 위반) 원래 에러를 올리고 users · identity도 롤백된다', async () => {
      await assert.rejects(repo.createUserWithPassword({ ...EMAIL_INPUT, passwordHash: null }), (err) => {
        assert.ok(!(err instanceof DuplicateIdentityError))
        return true
      })

      assert.equal(await db.countRows('users'), 0)
      assert.equal(await db.countRows('auth_identities'), 0)
    })

    it('findEmailCredential: 사용자와 해시를 돌려주고, 없으면 null', async () => {
      const created = await repo.createUserWithPassword(EMAIL_INPUT)

      assert.deepEqual(await repo.findEmailCredential(EMAIL_INPUT.email), { user: created, passwordHash: EMAIL_INPUT.passwordHash })
      assert.equal(await repo.findEmailCredential('nobody@example.com'), null)
    })

    it('findEmailCredential: provider가 email인 행만 본다 (같은 문자열 · 비밀번호 행이 붙은 kakao identity도 무시)', async () => {
      const [user] = await db.pool.execute('INSERT INTO users (display_name) VALUES (?)', ['소셜'])
      const [identity] = await db.pool.execute('INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, ?, ?)', [
        user.insertId,
        'kakao',
        EMAIL_INPUT.email,
      ])
      // 앱은 소셜 identity에 비밀번호 행을 만들지 않지만, provider 조건만으로 걸러지는지 보려고 일부러 붙인다
      await db.pool.execute('INSERT INTO password_credentials (identity_id, password_hash) VALUES (?, ?)', [
        identity.insertId,
        EMAIL_INPUT.passwordHash,
      ])

      assert.equal(await repo.findEmailCredential(EMAIL_INPUT.email), null)
    })
  })

  it('계정 로직 + DB: 재로그인 시 display_name은 처음 값을 유지한다', async () => {
    const service = createAccountService({ userRepository: repo })
    await service.loginWithIdentity(IDENTITY)

    await service.loginWithIdentity({ ...IDENTITY, displayName: '바뀐닉네임' })

    const [[row]] = await db.pool.query('SELECT display_name FROM users')
    assert.equal(row.display_name, IDENTITY.displayName)
  })
})
