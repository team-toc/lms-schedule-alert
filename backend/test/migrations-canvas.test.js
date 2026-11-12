import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, buildTestConfig } from './helpers/test-db.js'
import { createMigrator } from '../src/db/migrator.js'

const FIRST_CANVAS_MIGRATION = '0008_create_lms_tokens'
const LAST_CANVAS_MIGRATION = '0014_create_user_announcements'
const CANVAS_TABLES = [
  'lms_tokens',
  'courses',
  'enrollments',
  'assignments',
  'user_assignments',
  'announcements',
  'user_announcements',
]
const USER_SCOPED_TABLES = ['lms_tokens', 'enrollments', 'user_assignments', 'user_announcements']
const SHARED_TABLES = ['courses', 'assignments', 'announcements']
const HASH = 'a'.repeat(64)

async function columns(pool, table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [table],
  )
  return Object.fromEntries(rows.map((r) => [r.name, { type: r.type, nullable: r.nullable }]))
}

async function tableExists(pool, table) {
  const [rows] = await pool.query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])
  return rows.length === 1
}

async function insertUser(pool, name = '학생') {
  const [user] = await pool.execute('INSERT INTO users (display_name) VALUES (?)', [name])
  return user.insertId
}

// 사용자 한 명이 과목 · 과제 · 공지에 모두 연결된 상태를 만든다
async function seedLinkedUser(pool, { canvasCourseId = 101 } = {}) {
  const userId = await insertUser(pool)
  await pool.execute("INSERT INTO lms_tokens (user_id, token_enc) VALUES (?, 'v1:ciphertext')", [userId])
  const [course] = await pool.execute('INSERT INTO courses (canvas_course_id, name) VALUES (?, ?)', [canvasCourseId, '자료구조'])
  await pool.execute('INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)', [userId, course.insertId])
  const [assignment] = await pool.execute(
    'INSERT INTO assignments (course_id, canvas_id, title, content_hash) VALUES (?, ?, ?, ?)',
    [course.insertId, 501, '과제 1', HASH],
  )
  await pool.execute('INSERT INTO user_assignments (user_id, assignment_id, due_at) VALUES (?, ?, ?)', [
    userId,
    assignment.insertId,
    new Date('2026-11-20T14:59:00Z'),
  ])
  const [announcement] = await pool.execute(
    'INSERT INTO announcements (course_id, canvas_id, title, body, content_hash) VALUES (?, ?, ?, ?, ?)',
    [course.insertId, 701, '공지', '<p>본문</p>', HASH],
  )
  await pool.execute('INSERT INTO user_announcements (user_id, announcement_id) VALUES (?, ?)', [userId, announcement.insertId])
  return { userId, courseId: course.insertId }
}

describe('마이그레이션: Canvas 토큰 · 과목 · 과제 · 공지 (0008 ~ 0014)', () => {
  let db
  let migrator

  before(async () => {
    db = await openTestDb(buildTestConfig(), { holdMigrationLock: true })
    migrator = createMigrator(db.pool)
  })
  beforeEach(async () => {
    await migrator.up()
    await db.resetDatabase()
    // "0014 적용 직후" 상태: Canvas 마이그레이션을 모두 되돌린 뒤 0014까지만 다시 적용한다 (뒤에 번호가 늘어도 그대로)
    await migrator.down({ to: FIRST_CANVAS_MIGRATION })
    await migrator.up({ to: LAST_CANVAS_MIGRATION })
  })
  after(async () => {
    try {
      await migrator?.up()
    } finally {
      await db?.releaseMigrationLock()
      await db?.pool.end()
    }
  })

  it('0014 적용 직후: 7개 테이블이 있고 공유 assignments에는 due_at이 없다 (마감은 user_assignments.due_at, NULL 허용)', async () => {
    for (const table of CANVAS_TABLES) {
      assert.equal(await tableExists(db.pool, table), true, table)
    }
    assert.equal((await columns(db.pool, 'assignments')).due_at, undefined)
    assert.deepEqual((await columns(db.pool, 'user_assignments')).due_at, { type: 'datetime(3)', nullable: 'YES' })
  })

  it('lms_tokens.status: ENUM(syncing, ok, failing, needs_reauth) 순서, 기본 syncing', async () => {
    assert.equal((await columns(db.pool, 'lms_tokens')).status.type, "enum('syncing','ok','failing','needs_reauth')")
    const userId = await insertUser(db.pool)
    await db.pool.execute("INSERT INTO lms_tokens (user_id, token_enc) VALUES (?, 'v1:x')", [userId])

    const [[row]] = await db.pool.query('SELECT status, last_synced_at, last_error_code FROM lms_tokens')
    assert.deepEqual({ ...row }, { status: 'syncing', last_synced_at: null, last_error_code: null })
  })

  it('사용자 하나에 토큰은 하나 (UNIQUE user_id)', async () => {
    const userId = await insertUser(db.pool)
    await db.pool.execute("INSERT INTO lms_tokens (user_id, token_enc) VALUES (?, 'v1:a')", [userId])

    await assert.rejects(db.pool.execute("INSERT INTO lms_tokens (user_id, token_enc) VALUES (?, 'v1:b')", [userId]), { code: 'ER_DUP_ENTRY' })
  })

  it('과목은 Canvas id당 하나, 과제 · 공지는 (과목, Canvas id)당 하나이고 다른 과목의 같은 id는 별개 행', async () => {
    const { courseId } = await seedLinkedUser(db.pool)
    const [other] = await db.pool.execute('INSERT INTO courses (canvas_course_id, name) VALUES (?, ?)', [202, '알고리즘'])

    await assert.rejects(db.pool.execute('INSERT INTO courses (canvas_course_id, name) VALUES (?, ?)', [101, '중복']), { code: 'ER_DUP_ENTRY' })
    for (const table of ['assignments', 'announcements']) {
      const sql = `INSERT INTO ${table} (course_id, canvas_id, title, content_hash) VALUES (?, ?, ?, ?)`
      const canvasId = table === 'assignments' ? 501 : 701
      await assert.rejects(db.pool.execute(sql, [courseId, canvasId, '중복', HASH]), { code: 'ER_DUP_ENTRY' }, table)
      await db.pool.execute(sql, [other.insertId, canvasId, '다른 과목', HASH])
    }
  })

  it('사용자를 지우면 그 사용자의 토큰 · 수강 · 과제 연결 · 공지 연결이 함께 지워지고 공유 행은 남는다 (CASCADE)', async () => {
    const { userId } = await seedLinkedUser(db.pool)

    await db.pool.execute('DELETE FROM users WHERE id = ?', [userId])

    for (const table of USER_SCOPED_TABLES) {
      assert.equal(await db.countRows(table), 0, table)
    }
    for (const table of SHARED_TABLES) {
      assert.equal(await db.countRows(table), 1, table)
    }
  })

  it('연결이 남아 있는 공유 과목 · 과제는 지울 수 없다 (공유 행 쪽은 CASCADE 아님)', async () => {
    await seedLinkedUser(db.pool)

    await assert.rejects(db.pool.query('DELETE FROM assignments'), { code: 'ER_ROW_IS_REFERENCED_2' })
    await assert.rejects(db.pool.query('DELETE FROM courses'), { code: 'ER_ROW_IS_REFERENCED_2' })
  })

  it('공지 본문은 64KB(TEXT 한도)를 넘어도 잘리지 않고 저장된다 (MEDIUMTEXT)', async () => {
    const [course] = await db.pool.execute('INSERT INTO courses (canvas_course_id, name) VALUES (?, ?)', [101, '자료구조'])
    const bodies = [`<p>${'a'.repeat(100 * 1024)}</p>`, `<p>${'한'.repeat(70000)}</p>`] // ASCII 100KB, 한글 약 205KB(UTF-8)
    for (const [index, body] of bodies.entries()) {
      await db.pool.execute('INSERT INTO announcements (course_id, canvas_id, title, body, content_hash) VALUES (?, ?, ?, ?, ?)', [
        course.insertId,
        index + 1,
        '긴 공지',
        body,
        HASH,
      ])
    }

    const [rows] = await db.pool.query('SELECT body, OCTET_LENGTH(body) AS bytes FROM announcements ORDER BY canvas_id')
    assert.deepEqual(rows.map((r) => r.body), bodies)
    assert.ok(rows.every((r) => Number(r.bytes) > 65535), '두 본문 모두 TEXT 한도(65535바이트)를 넘어야 의미 있는 테스트')
  })

  it('VARCHAR(255) 제목 · 이름은 글자 수 기준: 255자(4바이트 이모지 포함)는 들어가고 256자는 strict 모드에서 거부된다 → 앱이 저장 전에 자른다', async () => {
    const [course] = await db.pool.execute('INSERT INTO courses (canvas_course_id, name) VALUES (?, ?)', [101, '😀'.repeat(255)])
    await db.pool.execute('INSERT INTO assignments (course_id, canvas_id, title, content_hash) VALUES (?, ?, ?, ?)', [
      course.insertId,
      1,
      '가'.repeat(255),
      HASH,
    ])

    await assert.rejects(db.pool.execute('INSERT INTO courses (canvas_course_id, name) VALUES (?, ?)', [102, 'a'.repeat(256)]), {
      code: 'ER_DATA_TOO_LONG',
    })
    await assert.rejects(
      db.pool.execute('INSERT INTO assignments (course_id, canvas_id, title, content_hash) VALUES (?, ?, ?, ?)', [course.insertId, 2, 'a'.repeat(256), HASH]),
      { code: 'ER_DATA_TOO_LONG' },
    )
  })

  it('조회용 인덱스: user_assignments(user_id, due_at) · enrollments(course_id) · user_announcements는 user_id로 시작하는 PK', async () => {
    const [rows] = await db.pool.query(
      `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() GROUP BY TABLE_NAME, INDEX_NAME`,
    )
    const indexes = new Set(rows.map((r) => `${r.tableName}.${r.indexName}(${r.cols})`))

    for (const expected of [
      'user_assignments.idx_user_assignments_user_due(user_id,due_at)',
      'enrollments.idx_enrollments_course(course_id)',
      'user_announcements.PRIMARY(user_id,announcement_id)',
      'user_assignments.PRIMARY(user_id,assignment_id)',
      'enrollments.PRIMARY(user_id,course_id)',
    ]) {
      assert.ok(indexes.has(expected), `인덱스 없음: ${expected}`)
    }
  })

  it('되돌리기: 토큰 행이 있으면 0008에서 멈추고 토큰은 남는다 (데이터 보존)', async () => {
    const userId = await insertUser(db.pool)
    await db.pool.execute("INSERT INTO lms_tokens (user_id, token_enc) VALUES (?, 'v1:keep')", [userId])

    await assert.rejects(migrator.down({ to: FIRST_CANVAS_MIGRATION }), /lms_tokens 테이블에 행이 있어 되돌리지 않음/)

    assert.equal(await db.countRows('lms_tokens'), 1)
    const executed = (await migrator.executed()).map((m) => m.name)
    assert.ok(executed.includes(FIRST_CANVAS_MIGRATION), '0008은 적용된 상태로 남아야 함')
  })

  it('되돌리기: 사용자 연결 행이 있으면 가장 먼저 되돌리는 0014에서 멈추고 아무 테이블도 지워지지 않는다', async () => {
    await seedLinkedUser(db.pool)

    await assert.rejects(migrator.down({ to: FIRST_CANVAS_MIGRATION }), /user_announcements 테이블에 행이 있어/)

    for (const table of CANVAS_TABLES) {
      assert.equal(await tableExists(db.pool, table), true, table)
    }
    assert.equal(await db.countRows('user_assignments'), 1)
  })

  it('행이 없으면 0014 → 0008 순서로 깨끗하게 되돌리고 다시 적용된다', async () => {
    await migrator.down({ to: FIRST_CANVAS_MIGRATION })
    for (const table of CANVAS_TABLES) {
      assert.equal(await tableExists(db.pool, table), false, table)
    }

    await migrator.up({ to: LAST_CANVAS_MIGRATION })

    for (const table of CANVAS_TABLES) {
      assert.equal(await tableExists(db.pool, table), true, table)
    }
  })
})
