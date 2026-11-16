import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, buildTestConfig } from './helpers/test-db.js'
import { createMigrator } from '../src/db/migrator.js'

const FIRST_MIGRATION = '0021_create_announcement_scans'
const LAST_MIGRATION = '0022_create_suggestions'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const START = new Date('2026-11-20T01:00:00Z')
const END = new Date('2026-11-20T02:00:00Z')
// MariaDB CHECK 위반은 errno 4025 (mysql2의 code 이름은 MySQL 기준이라 errno · 제약 이름으로 본다)
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

// 사용자 · Canvas 토큰 · 과목 · 공지 하나씩
async function seed(pool, name = '학생') {
  const [user] = await pool.execute('INSERT INTO users (display_name) VALUES (?)', [name])
  await pool.execute("INSERT INTO lms_tokens (user_id, token_enc) VALUES (?, 'v1:x')", [user.insertId])
  const [[course]] = await pool.query('SELECT id FROM courses WHERE canvas_course_id = 101')
  const courseId = course?.id ?? (await pool.execute("INSERT INTO courses (canvas_course_id, name) VALUES (101, '자료구조')"))[0].insertId
  const [[announcement]] = await pool.query('SELECT id FROM announcements WHERE canvas_id = 701')
  const announcementId =
    announcement?.id ?? (await pool.execute("INSERT INTO announcements (course_id, canvas_id, title, content_hash) VALUES (?, 701, '중간고사 안내', ?)", [courseId, HASH_A]))[0].insertId
  return { userId: user.insertId, announcementId }
}

function addSuggestion(pool, { userId, announcementId, candidateKey = HASH_A, start = START, end = END, scheduleId = null }) {
  return pool.execute(
    "INSERT INTO suggestions (user_id, announcement_id, candidate_key, kind, start_at, end_at, context, schedule_id) VALUES (?, ?, ?, 'exam', ?, ?, '중간고사 11월 20일 10시', ?)",
    [userId, announcementId, candidateKey, start, end, scheduleId],
  )
}

function addScan(pool, { userId, announcementId }) {
  return pool.execute('INSERT INTO announcement_scans (user_id, announcement_id, content_hash, scanned_at) VALUES (?, ?, ?, ?)', [userId, announcementId, HASH_A, START])
}

async function count(pool, table) {
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM ??', [table])
  return Number(row.n)
}

describe('마이그레이션: 공지 훑은 기록 · 일정 제안 (0021 ~ 0022)', () => {
  let db
  let migrator

  before(async () => {
    db = await openTestDb(buildTestConfig(), { holdMigrationLock: true })
    migrator = createMigrator(db.pool)
  })
  beforeEach(async () => {
    await migrator.up()
    await db.resetDatabase()
    // "0022 적용 직후": 0021부터 되돌린 뒤 0022까지만 다시 적용 (뒤에 번호가 늘어도 그대로)
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

  it('0022 적용 직후: suggestions 칼럼 · ENUM 순서(종류 · 상태, 만료는 저장 안 함), 공지 본문 칼럼 없음', async () => {
    const cols = await columns(db.pool, 'suggestions')

    assert.deepEqual(Object.keys(cols), [
      'id', 'user_id', 'announcement_id', 'candidate_key', 'kind', 'start_at', 'end_at', 'is_all_day', 'context', 'status', 'schedule_id',
      'created_at', 'updated_at', 'decided_at',
    ])
    assert.equal(cols.kind.type, "enum('exam','cancellation','makeup','deadline','other')")
    assert.deepEqual(cols.status, { type: "enum('pending','accepted','rejected')", nullable: 'NO', def: "'pending'" })
    assert.deepEqual([cols.candidate_key.type, cols.context.type, cols.schedule_id.nullable], ['char(64)', 'varchar(80)', 'YES'])
    assert.deepEqual(Object.keys(await columns(db.pool, 'announcement_scans')), ['user_id', 'announcement_id', 'content_hash', 'scanned_at'])
  })

  it('키 · 인덱스: 제안 중복 방지(사용자, 공지, 후보 키) · 목록(사용자, 상태, id) · FK용, 훑은 기록 PK(사용자, 공지)', async () => {
    const found = await indexes(db.pool)

    for (const expected of [
      'suggestions.uq_suggestions_user_announcement_candidate(user_id,announcement_id,candidate_key) UNIQUE',
      'suggestions.idx_suggestions_user_status(user_id,status,id)',
      'suggestions.idx_suggestions_announcement(announcement_id)',
      'suggestions.idx_suggestions_schedule(schedule_id)',
      'announcement_scans.PRIMARY(user_id,announcement_id) UNIQUE',
      'announcement_scans.idx_announcement_scans_announcement(announcement_id)',
    ]) {
      assert.ok(found.has(expected), `인덱스 없음: ${expected}`)
    }
  })

  it('같은 사용자 · 같은 공지 · 같은 후보 키는 하나, 후보 키가 다르거나 다른 사용자면 된다', async () => {
    const a = await seed(db.pool, 'A')
    const b = await seed(db.pool, 'B')
    await addSuggestion(db.pool, a)

    await assert.rejects(addSuggestion(db.pool, a), { code: 'ER_DUP_ENTRY' })
    await addSuggestion(db.pool, { ...a, candidateKey: HASH_B })
    await addSuggestion(db.pool, { ...b, announcementId: a.announcementId })
    assert.equal(await count(db.pool, 'suggestions'), 3)
  })

  it('CHECK: 시작 < 끝(제안은 항상 길이가 있음), 후보 키는 소문자 hex 64자', async () => {
    const a = await seed(db.pool)

    await assert.rejects(addSuggestion(db.pool, { ...a, start: END, end: END }), checkViolation('chk_suggestions_time'))
    await assert.rejects(addSuggestion(db.pool, { ...a, start: END, end: START }), checkViolation('chk_suggestions_time'))
    await assert.rejects(addSuggestion(db.pool, { ...a, candidateKey: 'Z'.repeat(64) }), checkViolation('chk_suggestions_candidate_key'))
  })

  it('Canvas 토큰 교체(INSERT … ON DUPLICATE KEY UPDATE)는 행을 UPDATE해 제안 · 훑은 기록이 남는다', async () => {
    const a = await seed(db.pool)
    await addSuggestion(db.pool, a)
    await addScan(db.pool, a)

    await db.pool.execute(
      "INSERT INTO lms_tokens (user_id, token_enc) VALUES (?, 'v1:new') ON DUPLICATE KEY UPDATE token_enc = VALUES(token_enc), status = 'syncing'",
      [a.userId],
    )

    assert.deepEqual([await count(db.pool, 'suggestions'), await count(db.pool, 'announcement_scans')], [1, 1])
  })

  it('연동 해제(lms_tokens 행 삭제) · 사용자 삭제 → 제안 · 훑은 기록이 함께 지워지고(CASCADE), 수락해서 만든 앱 일정은 남는다', async () => {
    const a = await seed(db.pool, 'A')
    const b = await seed(db.pool, 'B')
    const [schedule] = await db.pool.execute("INSERT INTO schedules (user_id, source, title, start_at, end_at) VALUES (?, 'app', '시험: 중간고사', ?, ?)", [a.userId, START, END])
    await addSuggestion(db.pool, { ...a, scheduleId: schedule.insertId })
    await addScan(db.pool, a)
    await addSuggestion(db.pool, b)

    await db.pool.execute('DELETE FROM lms_tokens WHERE user_id = ?', [a.userId])
    assert.deepEqual([await count(db.pool, 'suggestions'), await count(db.pool, 'announcement_scans')], [1, 0], 'A의 제안 · 기록만 지워짐')
    assert.equal(await count(db.pool, 'schedules'), 1, '앱 일정은 남음')

    await db.pool.execute('DELETE FROM users WHERE id = ?', [b.userId])
    assert.equal(await count(db.pool, 'suggestions'), 0, '사용자 삭제 → 토큰 → 제안')
  })

  it('만든 앱 일정 행을 지우면 제안의 schedule_id만 NULL(제안은 accepted로 남음), 제안이 가리키는 공지는 지울 수 없다', async () => {
    const a = await seed(db.pool)
    const [schedule] = await db.pool.execute("INSERT INTO schedules (user_id, source, title, start_at, end_at) VALUES (?, 'app', 'x', ?, ?)", [a.userId, START, END])
    await addSuggestion(db.pool, { ...a, scheduleId: schedule.insertId })
    await db.pool.query("UPDATE suggestions SET status = 'accepted'")

    await db.pool.execute('DELETE FROM schedules WHERE id = ?', [schedule.insertId])

    const [[row]] = await db.pool.query('SELECT status, schedule_id FROM suggestions')
    assert.deepEqual({ ...row }, { status: 'accepted', schedule_id: null })
    await assert.rejects(db.pool.query('DELETE FROM announcements'), { code: 'ER_ROW_IS_REFERENCED_2' })
  })

  const guardedDowns = [
    ['제안 행', async () => addSuggestion(db.pool, await seed(db.pool)), /suggestions 테이블에 행이 있어/, LAST_MIGRATION],
    ['훑은 기록 행', async () => addScan(db.pool, await seed(db.pool)), /announcement_scans 테이블에 행이 있어/, FIRST_MIGRATION],
  ]
  for (const [label, makeData, message, stopsAt] of guardedDowns) {
    it(`되돌리기: ${label}이 있으면 그 번호에서 멈추고 행이 남는다 (데이터 보존)`, async () => {
      await makeData()

      await assert.rejects(migrator.down({ to: FIRST_MIGRATION }), message)

      const executed = (await migrator.executed()).map((m) => m.name)
      assert.equal(executed.at(-1), stopsAt, `${stopsAt}는 적용된 상태로 남아야 함`)
    })
  }

  it('행이 없으면 0022 → 0021 순서로 깨끗하게 되돌리고 다시 적용된다', async () => {
    await migrator.down({ to: FIRST_MIGRATION })

    assert.deepEqual(await columns(db.pool, 'suggestions'), {})
    assert.deepEqual(await columns(db.pool, 'announcement_scans'), {})
    await migrator.up({ to: LAST_MIGRATION })
    assert.ok((await columns(db.pool, 'suggestions')).kind)
  })
})
