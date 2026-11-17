import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, buildTestConfig } from './helpers/test-db.js'
import { createMigrator } from '../src/db/migrator.js'

const FIRST_MIGRATION = '0019_create_calendar_links'
const LAST_MIGRATION = '0020_create_schedules'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const START = new Date('2026-11-20T01:00:00Z')
const END = new Date('2026-11-20T02:00:00Z')
// MariaDB CHECK 위반은 errno 4025 (mysql2가 붙이는 code 이름은 MySQL 기준이라 errno · 제약 이름으로 본다)
const checkViolation = (name) => ({ errno: 4025, message: new RegExp(name) })

async function columns(pool, table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [table],
  )
  return Object.fromEntries(rows.map((r) => [r.name, { type: r.type, nullable: r.nullable, def: r.def }]))
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

async function addLink(pool, userId, urlHash = HASH_A) {
  const [link] = await pool.execute("INSERT INTO calendar_links (user_id, provider, url_enc, url_hash) VALUES (?, 'icloud', 'v1:x', ?)", [userId, urlHash])
  return link.insertId
}

function addSchedule(pool, { userId, linkId = null, source = 'app', externalId = null, start = START, end = END }) {
  return pool.execute(
    'INSERT INTO schedules (user_id, calendar_link_id, source, external_id, title, start_at, end_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, linkId, source, externalId, '일정', start, end],
  )
}

describe('마이그레이션: 외부 캘린더 연결 · 일정 (0019 ~ 0020)', () => {
  let db
  let migrator

  before(async () => {
    db = await openTestDb(buildTestConfig(), { holdMigrationLock: true })
    migrator = createMigrator(db.pool)
  })
  beforeEach(async () => {
    await migrator.up()
    await db.resetDatabase()
    // "0020 적용 직후": 0019부터 되돌린 뒤 0020까지만 다시 적용 (뒤에 번호가 늘어도 그대로)
    await migrator.down({ to: FIRST_MIGRATION })
    await migrator.up({ to: LAST_MIGRATION })
  })
  after(async () => {
    try {
      await migrator?.up()
    } finally {
      await db?.releaseMigrationLock()
      await db?.pool.end()
    }
  })

  it('0020 적용 직후: calendar_links 칼럼 · ENUM 순서(제공자 icloud → google → kakao, 상태 기본 syncing), URL 원문 칼럼 없음', async () => {
    const cols = await columns(db.pool, 'calendar_links')

    assert.deepEqual(Object.keys(cols), [
      'id', 'user_id', 'provider', 'url_enc', 'url_hash', 'sync_status', 'last_synced_at', 'last_error_code', 'created_at', 'updated_at',
    ])
    assert.equal(cols.provider.type, "enum('icloud','google','kakao')")
    assert.deepEqual(cols.sync_status, { type: "enum('syncing','ok','failing','invalid')", nullable: 'NO', def: "'syncing'" })
    assert.deepEqual([cols.url_enc.type, cols.url_hash.type, cols.url_hash.nullable], ['varchar(2048)', 'char(64)', 'NO'])
  })

  it('0020 적용 직후: schedules 칼럼 · ENUM 순서(source app → icloud → google → kakao, status 기본 confirmed), 본문 · 설명 · 위치 칼럼 없음', async () => {
    const cols = await columns(db.pool, 'schedules')

    assert.deepEqual(Object.keys(cols), [
      'id', 'user_id', 'calendar_link_id', 'source', 'external_id', 'title', 'start_at', 'end_at', 'is_all_day', 'status',
      'content_hash', 'deleted_at', 'created_at', 'updated_at',
    ])
    assert.equal(cols.source.type, "enum('app','icloud','google','kakao')")
    assert.deepEqual(cols.status, { type: "enum('confirmed','tentative','cancelled')", nullable: 'NO', def: "'confirmed'" })
    assert.deepEqual([cols.external_id.type, cols.title.type, cols.start_at.type, cols.is_all_day.def], ['char(64)', 'varchar(255)', 'datetime(3)', '0'])
  })

  it('키 · 인덱스: 연결 중복 방지(사용자, URL 해시) · 주기 대상 · 회차 중복 방지(연결, external_id) · 기간 조회(사용자, 시작) · (사용자, 끝)', async () => {
    const found = await indexes(db.pool)

    for (const expected of [
      'calendar_links.uq_calendar_links_user_url(user_id,url_hash) UNIQUE',
      'calendar_links.idx_calendar_links_sync_targets(sync_status,last_synced_at)',
      'schedules.uq_schedules_link_external(calendar_link_id,external_id) UNIQUE',
      'schedules.idx_schedules_user_start(user_id,start_at)',
      'schedules.idx_schedules_user_end(user_id,end_at)',
    ]) {
      assert.ok(found.has(expected), `인덱스 없음: ${expected}`)
    }
  })

  it('같은 사용자는 같은 URL 해시를 두 번 등록할 수 없고, 다른 사용자 · 다른 해시는 된다', async () => {
    const a = await addUser(db.pool)
    const b = await addUser(db.pool)
    await addLink(db.pool, a, HASH_A)

    await assert.rejects(addLink(db.pool, a, HASH_A), { code: 'ER_DUP_ENTRY' })
    await addLink(db.pool, a, HASH_B)
    await addLink(db.pool, b, HASH_A)
    await assert.rejects(addLink(db.pool, a, 'Z'.repeat(64)), checkViolation('chk_calendar_links_url_hash'))
  })

  it('같은 연결 안에서 external_id는 하나, 앱 일정(연결 없음)은 여러 개', async () => {
    const userId = await addUser(db.pool)
    const linkId = await addLink(db.pool, userId)
    await addSchedule(db.pool, { userId, linkId, source: 'icloud', externalId: HASH_A })

    await assert.rejects(addSchedule(db.pool, { userId, linkId, source: 'icloud', externalId: HASH_A }), { code: 'ER_DUP_ENTRY' })
    await addSchedule(db.pool, { userId })
    await addSchedule(db.pool, { userId })
    assert.equal(await db.countRows('schedules'), 3)
  })

  it('CHECK: 시작 ≤ 끝(길이 0 허용, 끝이 앞서면 거부), 앱 일정은 연결 · external_id 없음, 외부 일정은 둘 다 있음', async () => {
    const userId = await addUser(db.pool)
    const linkId = await addLink(db.pool, userId)

    await addSchedule(db.pool, { userId, start: END, end: END })
    await assert.rejects(addSchedule(db.pool, { userId, start: END, end: START }), checkViolation('chk_schedules_time'))
    await assert.rejects(addSchedule(db.pool, { userId, linkId }), checkViolation('chk_schedules_source_link'))
    await assert.rejects(addSchedule(db.pool, { userId, source: 'icloud', externalId: HASH_A }), checkViolation('chk_schedules_source_link'))
    await assert.rejects(addSchedule(db.pool, { userId, linkId, source: 'icloud' }), checkViolation('chk_schedules_source_external'))
    await assert.rejects(addSchedule(db.pool, { userId, externalId: HASH_A }), checkViolation('chk_schedules_source_external'))
  })

  it('연결을 지우면 그 연결의 일정만 지워지고(CASCADE), 사용자를 지우면 연결 · 앱 일정 모두 지워진다', async () => {
    const a = await addUser(db.pool)
    const b = await addUser(db.pool)
    const linkA = await addLink(db.pool, a)
    const linkB = await addLink(db.pool, b)
    await addSchedule(db.pool, { userId: a, linkId: linkA, source: 'icloud', externalId: HASH_A })
    await addSchedule(db.pool, { userId: a })
    await addSchedule(db.pool, { userId: b, linkId: linkB, source: 'icloud', externalId: HASH_A })

    await db.pool.execute('DELETE FROM calendar_links WHERE id = ?', [linkA])
    assert.equal(await db.countRows('schedules'), 2, '연결 A의 일정만 지워짐')

    await db.pool.execute('DELETE FROM users WHERE id = ?', [a])
    assert.equal(await db.countRows('schedules'), 1, '사용자 A의 앱 일정도 지워짐, B는 그대로')
    assert.equal(await db.countRows('calendar_links'), 1)
  })

  const guardedDowns = [
    ['일정 행', async () => addSchedule(db.pool, { userId: await addUser(db.pool) }), /schedules 테이블에 행이 있어/, LAST_MIGRATION],
    ['연결 행', async () => addLink(db.pool, await addUser(db.pool)), /calendar_links 테이블에 행이 있어/, FIRST_MIGRATION],
  ]
  for (const [label, makeData, message, stopsAt] of guardedDowns) {
    it(`되돌리기: ${label}이 있으면 그 번호에서 멈추고 행이 남는다 (데이터 보존)`, async () => {
      await makeData()

      await assert.rejects(migrator.down({ to: FIRST_MIGRATION }), message)

      const executed = (await migrator.executed()).map((m) => m.name)
      assert.equal(executed.at(-1), stopsAt, `${stopsAt}는 적용된 상태로 남아야 함`)
    })
  }

  it('행이 없으면 0020 → 0019 순서로 깨끗하게 되돌리고 다시 적용된다', async () => {
    await migrator.down({ to: FIRST_MIGRATION })

    assert.deepEqual(await columns(db.pool, 'schedules'), {})
    assert.deepEqual(await columns(db.pool, 'calendar_links'), {})
    await migrator.up({ to: LAST_MIGRATION })
    assert.ok((await columns(db.pool, 'schedules')).source)
  })
})
