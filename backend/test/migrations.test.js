import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, buildTestConfig } from './helpers/test-db.js'
import { createMigrator } from '../src/db/migrator.js'

const GOOGLE_PROVIDER_MIGRATION = '0004_add_google_provider'
const WIDEN_PROVIDER_USER_ID_MIGRATION = '0005_widen_provider_user_id'
// 0005 직후 상태를 보려면 이것부터 되돌린다 (이메일 로그인 마이그레이션)
const FIRST_MIGRATION_AFTER_0005 = '0006_create_password_credentials'
const PROVIDER_USER_ID_MAX_LENGTH = 255
const KAKAO_ID = '4000000001'

async function columnType(pool, column) {
  const [[row]] = await pool.query(
    `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_identities' AND COLUMN_NAME = ?`,
    [column],
  )
  return row.type
}

async function insertIdentity(pool, { provider, providerUserId, displayName = '테스트사용자' }) {
  const [user] = await pool.execute('INSERT INTO users (display_name) VALUES (?)', [displayName])
  await pool.execute('INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, ?, ?)', [
    user.insertId,
    provider,
    providerUserId,
  ])
  return user.insertId
}

async function identityRows(pool) {
  const [rows] = await pool.query(
    'SELECT user_id, provider, provider_user_id FROM auth_identities ORDER BY id',
  )
  return rows.map((row) => ({ ...row }))
}

describe('마이그레이션: Google 제공자 · provider_user_id 확장', () => {
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
    // 다른 테스트 파일이 최신 스키마를 쓰도록 되돌려 둔다. 실패해도 잠금 · 연결은 반드시 정리한다.
    try {
      await migrator?.up()
    } finally {
      await db?.releaseMigrationLock()
      await db?.pool.end()
    }
  })

  it('0005 적용 직후: provider = ENUM(kakao, google) 순서, provider_user_id = VARCHAR(255)', async () => {
    await migrator.down({ to: FIRST_MIGRATION_AFTER_0005 })

    assert.equal(await columnType(db.pool, 'provider'), "enum('kakao','google')")
    assert.equal(await columnType(db.pool, 'provider_user_id'), `varchar(${PROVIDER_USER_ID_MAX_LENGTH})`)
  })

  it('0004 · 0005 적용 전에 있던 kakao 행이 적용 후에도 그대로 남는다', async () => {
    await migrator.down({ to: GOOGLE_PROVIDER_MIGRATION })
    assert.equal(await columnType(db.pool, 'provider'), "enum('kakao')")
    const userId = await insertIdentity(db.pool, { provider: 'kakao', providerUserId: KAKAO_ID })
    const before = await identityRows(db.pool)

    await migrator.up()

    assert.deepEqual(await identityRows(db.pool), before)
    assert.deepEqual(before, [{ user_id: userId, provider: 'kakao', provider_user_id: KAKAO_ID }])
  })

  it('google 행을 넣을 수 있고, 같은 값의 kakao · google id는 서로 다른 행이다', async () => {
    await insertIdentity(db.pool, { provider: 'kakao', providerUserId: KAKAO_ID })
    await insertIdentity(db.pool, { provider: 'google', providerUserId: KAKAO_ID })

    assert.equal(await db.countRows('auth_identities'), 2)
  })

  it('255자 provider_user_id는 저장되고, 256자는 거부된다 (strict 모드)', async () => {
    const longest = 'a'.repeat(PROVIDER_USER_ID_MAX_LENGTH)
    await insertIdentity(db.pool, { provider: 'google', providerUserId: longest })

    await assert.rejects(insertIdentity(db.pool, { provider: 'google', providerUserId: longest + 'a' }), {
      code: 'ER_DATA_TOO_LONG',
    })
    const [[row]] = await db.pool.query('SELECT CHAR_LENGTH(provider_user_id) AS len FROM auth_identities')
    assert.equal(Number(row.len), PROVIDER_USER_ID_MAX_LENGTH)
  })

  it('확장 후에도 UNIQUE(provider, provider_user_id)가 유지된다 (긴 id 포함)', async () => {
    const [indexRows] = await db.pool.query(
      "SHOW INDEX FROM auth_identities WHERE Key_name = 'uq_auth_identities_provider_user'",
    )
    assert.deepEqual(
      indexRows.map((r) => [r.Column_name, Number(r.Non_unique), r.Sub_part]),
      [
        ['provider', 0, null],
        ['provider_user_id', 0, null],
      ],
      '접두 인덱스가 아니라 전체 값에 대한 UNIQUE여야 함',
    )
    const longId = 'g'.repeat(PROVIDER_USER_ID_MAX_LENGTH)
    await insertIdentity(db.pool, { provider: 'google', providerUserId: longId })

    await assert.rejects(insertIdentity(db.pool, { provider: 'google', providerUserId: longId }), {
      code: 'ER_DUP_ENTRY',
    })
  })

  it('down: google 행이 남아 있으면 0004 되돌리기가 실패해 데이터를 지우지 않는다', async () => {
    await insertIdentity(db.pool, { provider: 'google', providerUserId: 'google-sub-1' })

    await assert.rejects(migrator.down({ to: GOOGLE_PROVIDER_MIGRATION }))

    const [[row]] = await db.pool.query('SELECT provider FROM auth_identities')
    assert.equal(row.provider, 'google')
  })

  it('down: 64자를 넘는 id가 있으면 0005 되돌리기가 실패해 값을 자르지 않는다', async () => {
    const longId = 'x'.repeat(100)
    await insertIdentity(db.pool, { provider: 'kakao', providerUserId: longId })

    await assert.rejects(migrator.down({ to: WIDEN_PROVIDER_USER_ID_MIGRATION }))

    const [[row]] = await db.pool.query('SELECT provider_user_id FROM auth_identities')
    assert.equal(row.provider_user_id, longId)
  })

  it('행이 없으면 0005 → 0004 순서로 깨끗하게 되돌리고 다시 적용된다', async () => {
    await migrator.down({ to: GOOGLE_PROVIDER_MIGRATION })
    assert.equal(await columnType(db.pool, 'provider_user_id'), 'varchar(64)')
    assert.equal(await columnType(db.pool, 'provider'), "enum('kakao')")

    await migrator.up()

    const pending = await migrator.pending()
    assert.deepEqual(pending, [])
  })
})
