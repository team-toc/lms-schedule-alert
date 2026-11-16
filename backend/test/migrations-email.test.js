import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, buildTestConfig } from './helpers/test-db.js'
import { createMigrator } from '../src/db/migrator.js'

const CREATE_CREDENTIALS_MIGRATION = '0006_create_password_credentials'
const ADD_EMAIL_PROVIDER_MIGRATION = '0007_add_email_provider'
const FAKE_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA'

async function columns(pool, table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [table],
  )
  return Object.fromEntries(rows.map((r) => [r.name, { type: r.type, nullable: r.nullable, def: r.def }]))
}

async function tableExists(pool, table) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table],
  )
  return rows.length === 1
}

async function insertIdentity(pool, { provider, providerUserId }) {
  const [user] = await pool.execute('INSERT INTO users (display_name) VALUES (?)', ['테스트사용자'])
  const [identity] = await pool.execute(
    'INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, ?, ?)',
    [user.insertId, provider, providerUserId],
  )
  return identity.insertId
}

async function identityRows(pool) {
  const [rows] = await pool.query('SELECT id, user_id, provider, provider_user_id FROM auth_identities ORDER BY id')
  return rows.map((row) => ({ ...row }))
}

describe('마이그레이션: 이메일 로그인 (password_credentials · provider email)', () => {
  let db
  let migrator

  before(async () => {
    db = await openTestDb(buildTestConfig(), { holdMigrationLock: true })
    migrator = createMigrator(db.pool)
  })
  beforeEach(async () => {
    await migrator.up()
    await db.resetDatabase()
  })
  after(async () => {
    // 실패해도 잠금 · 연결은 반드시 정리한다
    try {
      await migrator?.up()
    } finally {
      await db?.releaseMigrationLock()
      await db?.pool.end()
    }
  })

  it("최신 스키마: provider = ENUM('kakao', 'google', 'email') — 기존 값 순서 유지, email은 맨 뒤", async () => {
    assert.equal((await columns(db.pool, 'auth_identities')).provider.type, "enum('kakao','google','email')")
  })

  it('password_credentials 칼럼: identity_id · password_hash · email_verified(기본 false) · created_at · updated_at', async () => {
    const cols = await columns(db.pool, 'password_credentials')

    assert.deepEqual(Object.keys(cols), ['id', 'identity_id', 'password_hash', 'email_verified', 'created_at', 'updated_at'])
    assert.equal(cols.identity_id.type, 'bigint(20) unsigned')
    assert.equal(cols.password_hash.type, 'varchar(255)')
    assert.equal(cols.password_hash.nullable, 'NO')
    assert.equal(cols.email_verified.type, 'tinyint(1)')
    assert.equal(cols.email_verified.def, '0')
  })

  it('identity_id는 UNIQUE + auth_identities.id 외래키(ON DELETE CASCADE)', async () => {
    const [unique] = await db.pool.query("SHOW INDEX FROM password_credentials WHERE Column_name = 'identity_id' AND Non_unique = 0")
    assert.equal(unique.length, 1)
    const [[fk]] = await db.pool.query(
      `SELECT REFERENCED_TABLE_NAME AS ref, DELETE_RULE AS onDelete FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'password_credentials'`,
    )
    assert.deepEqual({ ...fk }, { ref: 'auth_identities', onDelete: 'CASCADE' })
  })

  it('email 행 + 비밀번호 행을 넣을 수 있고, 같은 identity에 두 번째 비밀번호 행은 거부된다', async () => {
    const identityId = await insertIdentity(db.pool, { provider: 'email', providerUserId: 'user@example.com' })
    await db.pool.execute('INSERT INTO password_credentials (identity_id, password_hash) VALUES (?, ?)', [identityId, FAKE_HASH])

    await assert.rejects(
      db.pool.execute('INSERT INTO password_credentials (identity_id, password_hash) VALUES (?, ?)', [identityId, FAKE_HASH]),
      { code: 'ER_DUP_ENTRY' },
    )
    const [[row]] = await db.pool.query('SELECT email_verified FROM password_credentials')
    assert.equal(row.email_verified, 0, 'email_verified 기본값은 false')
  })

  it('identity를 지우면 비밀번호 행도 함께 지워진다 (CASCADE)', async () => {
    const identityId = await insertIdentity(db.pool, { provider: 'email', providerUserId: 'user@example.com' })
    await db.pool.execute('INSERT INTO password_credentials (identity_id, password_hash) VALUES (?, ?)', [identityId, FAKE_HASH])

    await db.pool.execute('DELETE FROM users')

    assert.equal(await db.countRows('password_credentials'), 0)
  })

  it('12. 0006 · 0007 적용 전에 있던 kakao · google 행이 적용 후에도 그대로 남는다', async () => {
    await migrator.down({ to: CREATE_CREDENTIALS_MIGRATION })
    assert.equal(await tableExists(db.pool, 'password_credentials'), false)
    await insertIdentity(db.pool, { provider: 'kakao', providerUserId: '4000000001' })
    await insertIdentity(db.pool, { provider: 'google', providerUserId: '109876543210987654321' })
    const before = await identityRows(db.pool)

    await migrator.up()

    assert.deepEqual(await identityRows(db.pool), before)
  })

  it('12. 되돌리기: email 행이 있으면 0007에서 멈추고, 비밀번호 행 · 테이블이 남는다 (데이터 보존)', async () => {
    const identityId = await insertIdentity(db.pool, { provider: 'email', providerUserId: 'user@example.com' })
    await db.pool.execute('INSERT INTO password_credentials (identity_id, password_hash) VALUES (?, ?)', [identityId, FAKE_HASH])

    await assert.rejects(migrator.down({ to: CREATE_CREDENTIALS_MIGRATION }))

    assert.equal(await tableExists(db.pool, 'password_credentials'), true, '0006 DROP TABLE까지 가면 안 됨')
    assert.equal(await db.countRows('password_credentials'), 1)
    const [[identity]] = await db.pool.query('SELECT provider, provider_user_id FROM auth_identities')
    assert.deepEqual({ ...identity }, { provider: 'email', provider_user_id: 'user@example.com' })
    const executed = (await migrator.executed()).map((m) => m.name)
    assert.ok(executed.includes(ADD_EMAIL_PROVIDER_MIGRATION), '0007은 적용된 상태로 남아야 함')
  })

  it('행이 없으면 0007 → 0006 순서로 깨끗하게 되돌리고 다시 적용된다', async () => {
    await migrator.down({ to: CREATE_CREDENTIALS_MIGRATION })
    assert.equal((await columns(db.pool, 'auth_identities')).provider.type, "enum('kakao','google')")

    await migrator.up()

    assert.deepEqual(await migrator.pending(), [])
    assert.equal(await tableExists(db.pool, 'password_credentials'), true)
  })
})
