import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, buildTestConfig } from './helpers/test-db.js'
import { createMigrator } from '../src/db/migrator.js'

const MIGRATION = '0023_create_push_subscriptions'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
// MariaDB CHECK 위반은 errno 4025 (mysql2의 code 이름은 MySQL 기준이라 errno · 제약 이름으로 본다)
const checkViolation = (name) => ({ errno: 4025, message: new RegExp(name) })

async function columns(pool, table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, CHARACTER_SET_NAME AS charset
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [table],
  )
  return Object.fromEntries(rows.map((r) => [r.name, { type: r.type, nullable: r.nullable, def: r.def, charset: r.charset }]))
}

async function indexes(pool) {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS c
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
  )
  return new Set(rows.map((r) => `${r.t}.${r.i}(${r.c})${Number(r.nu) === 0 ? ' UNIQUE' : ''}`))
}

async function addUser(pool, name = '학생') {
  const [user] = await pool.execute('INSERT INTO users (display_name) VALUES (?)', [name])
  return user.insertId
}

function addSubscription(pool, { userId, hash = HASH_A, enc = 'v1:x' }) {
  return pool.execute('INSERT INTO push_subscriptions (user_id, endpoint_hash, subscription_enc) VALUES (?, ?, ?)', [userId, hash, enc])
}

async function rows(pool) {
  const [list] = await pool.query('SELECT user_id, endpoint_hash, subscription_enc FROM push_subscriptions ORDER BY id')
  return list.map((r) => ({ ...r }))
}

// 브라우저 푸시 구독 (ADR 0012): endpoint는 암호문 + 키 있는 해시만, endpoint당 한 행(주인 이전), 계정 삭제 때 함께
describe('마이그레이션: 브라우저 푸시 구독 (0023)', () => {
  let db
  let migrator

  before(async () => {
    db = await openTestDb(buildTestConfig(), { holdMigrationLock: true })
    migrator = createMigrator(db.pool)
  })
  beforeEach(async () => {
    await migrator.up()
    await db.resetDatabase()
    // "0023 적용 직후": 0023을 되돌린 뒤 0023까지만 다시 적용 (뒤에 번호가 늘어도 그대로)
    await migrator.down({ to: MIGRATION })
    await migrator.up({ to: MIGRATION })
  })
  after(async () => {
    try {
      await migrator?.up()
    } finally {
      await db?.releaseMigrationLock()
      await db?.pool.end()
    }
  })

  it('0023 적용 직후: 칼럼 · 형식, endpoint · 키 원문 칼럼 없음(암호문 · 해시만, ascii)', async () => {
    const cols = await columns(db.pool, 'push_subscriptions')

    assert.deepEqual(Object.keys(cols), [
      'id', 'user_id', 'endpoint_hash', 'subscription_enc', 'created_at', 'updated_at', 'last_success_at', 'consecutive_failures', 'last_failure_code',
    ])
    assert.deepEqual([cols.endpoint_hash.type, cols.endpoint_hash.charset], ['char(64)', 'ascii'])
    assert.deepEqual([cols.subscription_enc.type, cols.subscription_enc.charset, cols.subscription_enc.nullable], ['varchar(4096)', 'ascii', 'NO'])
    assert.deepEqual(cols.consecutive_failures, { type: 'int(10) unsigned', nullable: 'NO', def: '0', charset: null })
    assert.deepEqual([cols.last_success_at.nullable, cols.last_failure_code.nullable], ['YES', 'YES'])
    for (const name of Object.keys(cols)) {
      assert.ok(!/^(endpoint|p256dh|auth|keys)$/.test(name), `원문 칼럼이 있으면 안 됨: ${name}`)
    }
  })

  it('키 · 인덱스: endpoint 해시 UNIQUE(사용자와 상관없이), 사용자별 목록', async () => {
    const found = await indexes(db.pool)

    for (const expected of ['push_subscriptions.uq_push_subscriptions_endpoint(endpoint_hash) UNIQUE', 'push_subscriptions.idx_push_subscriptions_user(user_id,id)']) {
      assert.ok(found.has(expected), `인덱스 없음: ${expected}`)
    }
  })

  it('같은 endpoint는 다른 사용자라도 한 행: 그냥 넣으면 중복 오류, ON DUPLICATE KEY UPDATE로 주인 · 암호문이 바뀐다(행 1개)', async () => {
    const a = await addUser(db.pool, 'A')
    const b = await addUser(db.pool, 'B')
    await addSubscription(db.pool, { userId: a })

    await assert.rejects(addSubscription(db.pool, { userId: b }), { code: 'ER_DUP_ENTRY' })
    await db.pool.execute(
      `INSERT INTO push_subscriptions (user_id, endpoint_hash, subscription_enc) VALUES (?, ?, 'v1:b')
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), subscription_enc = VALUES(subscription_enc)`,
      [b, HASH_A],
    )
    await addSubscription(db.pool, { userId: a, hash: HASH_B })

    assert.deepEqual(await rows(db.pool), [
      { user_id: b, endpoint_hash: HASH_A, subscription_enc: 'v1:b' },
      { user_id: a, endpoint_hash: HASH_B, subscription_enc: 'v1:x' },
    ])
  })

  it('CHECK: endpoint 해시는 소문자 hex 64자, 연속 실패 횟수는 음수 불가 · 기본 0', async () => {
    const a = await addUser(db.pool)

    await assert.rejects(addSubscription(db.pool, { userId: a, hash: 'Z'.repeat(64) }), checkViolation('chk_push_subscriptions_endpoint_hash'))
    await assert.rejects(addSubscription(db.pool, { userId: a, hash: 'a'.repeat(63) }), checkViolation('chk_push_subscriptions_endpoint_hash'))
    await addSubscription(db.pool, { userId: a })
    const [[row]] = await db.pool.query('SELECT consecutive_failures, last_success_at FROM push_subscriptions')
    assert.deepEqual({ ...row }, { consecutive_failures: 0, last_success_at: null })
    await assert.rejects(db.pool.query('UPDATE push_subscriptions SET consecutive_failures = -1'), { code: 'ER_WARN_DATA_OUT_OF_RANGE' })
  })

  it('사용자 삭제 → 그 사용자의 구독만 지워지고(CASCADE), Canvas 연동 해제(lms_tokens 삭제)와는 무관하다', async () => {
    const a = await addUser(db.pool, 'A')
    const b = await addUser(db.pool, 'B')
    await db.pool.execute("INSERT INTO lms_tokens (user_id, token_enc) VALUES (?, 'v1:t')", [a])
    await addSubscription(db.pool, { userId: a })
    await addSubscription(db.pool, { userId: b, hash: HASH_B })

    await db.pool.execute('DELETE FROM lms_tokens WHERE user_id = ?', [a])
    assert.equal((await rows(db.pool)).length, 2, 'Canvas 연동 해제로는 안 지워짐')

    await db.pool.execute('DELETE FROM users WHERE id = ?', [a])
    assert.deepEqual((await rows(db.pool)).map((r) => r.user_id), [b])
  })

  it('되돌리기: 구독 행이 있으면 실패하고 0023이 적용된 상태로 남는다 (데이터 보존)', async () => {
    await addSubscription(db.pool, { userId: await addUser(db.pool) })

    await assert.rejects(migrator.down({ to: MIGRATION }), /push_subscriptions 테이블에 행이 있어/)

    assert.equal((await migrator.executed()).map((m) => m.name).at(-1), MIGRATION)
    assert.equal((await rows(db.pool)).length, 1)
  })

  it('행이 없으면 깨끗하게 되돌리고 다시 적용된다', async () => {
    await migrator.down({ to: MIGRATION })

    assert.deepEqual(await columns(db.pool, 'push_subscriptions'), {})
    await migrator.up({ to: MIGRATION })
    assert.ok((await columns(db.pool, 'push_subscriptions')).endpoint_hash)
  })
})
