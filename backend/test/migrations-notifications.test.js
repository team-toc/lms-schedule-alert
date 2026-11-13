import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, buildTestConfig } from './helpers/test-db.js'
import { createMigrator } from '../src/db/migrator.js'

const FIRST_MIGRATION = '0015_add_lms_token_canvas_account'
const LAST_MIGRATION = '0018_create_notifications'
const HASH = 'a'.repeat(64)
const KINDS = "enum('assignment_created','assignment_due_changed','assignment_title_changed','assignment_removed','announcement_created','announcement_updated')"

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
    `SELECT TABLE_NAME AS t, INDEX_NAME AS i, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS c
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() GROUP BY TABLE_NAME, INDEX_NAME`,
  )
  return new Set(rows.map((r) => `${r.t}.${r.i}(${r.c})`))
}

// 사용자 · 토큰 · 과목 · 과제 · 공지 하나씩, 사용자는 과제 · 공지에 연결
async function seed(pool) {
  const [user] = await pool.execute('INSERT INTO users (display_name) VALUES (?)', ['학생'])
  await pool.execute("INSERT INTO lms_tokens (user_id, token_enc) VALUES (?, 'v1:x')", [user.insertId])
  const [course] = await pool.execute('INSERT INTO courses (canvas_course_id, name) VALUES (101, ?)', ['자료구조'])
  const [assignment] = await pool.execute('INSERT INTO assignments (course_id, canvas_id, title, content_hash) VALUES (?, 501, ?, ?)', [course.insertId, '과제', HASH])
  const [announcement] = await pool.execute('INSERT INTO announcements (course_id, canvas_id, title, content_hash) VALUES (?, 701, ?, ?)', [course.insertId, '공지', HASH])
  await pool.execute('INSERT INTO user_assignments (user_id, assignment_id) VALUES (?, ?)', [user.insertId, assignment.insertId])
  await pool.execute('INSERT INTO user_announcements (user_id, announcement_id) VALUES (?, ?)', [user.insertId, announcement.insertId])
  return { userId: user.insertId, assignmentId: assignment.insertId, announcementId: announcement.insertId }
}

function insertNotification(pool, { userId, assignmentId = null, announcementId = null, kind = 'assignment_created' }) {
  return pool.execute('INSERT INTO notifications (user_id, kind, assignment_id, announcement_id, detected_at) VALUES (?, ?, ?, ?, ?)', [
    userId,
    kind,
    assignmentId,
    announcementId,
    new Date('2026-11-13T00:00:00Z'),
  ])
}

describe('마이그레이션: 변경 감지 · 알림 (0015 ~ 0018)', () => {
  let db
  let migrator

  before(async () => {
    db = await openTestDb(buildTestConfig(), { holdMigrationLock: true })
    migrator = createMigrator(db.pool)
  })
  beforeEach(async () => {
    await migrator.up()
    await db.resetDatabase()
    // "0018 적용 직후": 0015부터 되돌린 뒤 0018까지만 다시 적용 (뒤에 번호가 늘어도 그대로)
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

  it('0018 적용 직후: lms_tokens에 계정 id(NULL 허용) · 기준 동기화 표시(기본 TRUE), 연결 표에 본 값(NULL 허용)', async () => {
    const tokens = await columns(db.pool, 'lms_tokens')
    // Canvas id는 2^53을 넘을 수 있어 문자열로 저장한다 (JS Number · mysql2 BIGINT 읽기는 정밀도를 잃음)
    assert.deepEqual(tokens.canvas_user_id, { type: 'varchar(20)', nullable: 'YES', def: 'NULL' })
    assert.equal(tokens.baseline_required.type, 'tinyint(1)')
    assert.equal(tokens.baseline_required.nullable, 'NO')
    assert.equal(tokens.baseline_required.def, '1')
    assert.equal((await columns(db.pool, 'user_assignments')).seen_title.nullable, 'YES')
    const announcements = await columns(db.pool, 'user_announcements')
    assert.deepEqual([announcements.seen_title.nullable, announcements.seen_content_hash.type], ['YES', 'char(64)'])
  })

  it('기존 토큰 행은 계정 id 없음 · baseline_required = 1 (다음 동기화는 기준 동기화)', async () => {
    const { userId } = await seed(db.pool)

    const [[row]] = await db.pool.query('SELECT canvas_user_id, baseline_required FROM lms_tokens WHERE user_id = ?', [userId])
    assert.deepEqual({ ...row }, { canvas_user_id: null, baseline_required: 1 })
  })

  it('canvas_user_id: 2^53을 넘는 id를 문자열 그대로 저장 · 비교 (마지막 자리만 달라도 다름), 숫자가 아닌 값은 CHECK로 거부', async () => {
    const { userId } = await seed(db.pool)
    const big = '9007199254740993'
    assert.notEqual(big, String(Number(big)), '전제: Number로 바꾸면 정밀도를 잃는 값')

    await db.pool.execute('UPDATE lms_tokens SET canvas_user_id = ? WHERE user_id = ?', [big, userId])
    const [[row]] = await db.pool.query('SELECT canvas_user_id FROM lms_tokens WHERE user_id = ?', [userId])
    assert.equal(row.canvas_user_id, big)
    const same = async (id) => (await db.pool.query('SELECT COUNT(*) AS n FROM lms_tokens WHERE canvas_user_id = ?', [id]))[0][0].n
    assert.equal(await same(big), 1)
    assert.equal(await same('9007199254740992'), 0, '마지막 자리만 다른 id')
    assert.equal(await same('09007199254740993'), 0, '앞자리 0은 같은 id로 보지 않음(저장 쪽에서 막음)')

    for (const bad of ['', '0', '0123', '12a', '-5', '1'.repeat(21)]) {
      await assert.rejects(db.pool.execute('UPDATE lms_tokens SET canvas_user_id = ? WHERE user_id = ?', [bad, userId]), `거부해야 함: "${bad}"`)
    }
    await db.pool.execute('UPDATE lms_tokens SET canvas_user_id = ? WHERE user_id = ?', ['18446744073709551615', userId])
  })

  it('notifications: kind ENUM 순서, 본문 칼럼 없음', async () => {
    const cols = await columns(db.pool, 'notifications')

    assert.equal(cols.kind.type, KINDS)
    assert.deepEqual(Object.keys(cols), [
      'id', 'user_id', 'kind', 'assignment_id', 'announcement_id', 'before_due_at', 'after_due_at', 'before_title', 'after_title', 'detected_at', 'read_at',
    ])
  })

  it('조회용 인덱스: 목록(사용자, id) · 안 읽은 목록(사용자, read_at, id) · 합치기(사용자, 대상, 종류, read_at)', async () => {
    const found = await indexes(db.pool)

    for (const expected of [
      'notifications.idx_notifications_user_list(user_id,id)',
      'notifications.idx_notifications_user_unread(user_id,read_at,id)',
      'notifications.idx_notifications_merge_assignment(user_id,assignment_id,kind,read_at)',
      'notifications.idx_notifications_merge_announcement(user_id,announcement_id,kind,read_at)',
    ]) {
      assert.ok(found.has(expected), `인덱스 없음: ${expected}`)
    }
  })

  it('대상은 과제 또는 공지 정확히 하나 (둘 다 · 둘 다 없음은 CHECK로 거부)', async () => {
    const ids = await seed(db.pool)
    await insertNotification(db.pool, { userId: ids.userId, assignmentId: ids.assignmentId })
    await insertNotification(db.pool, { userId: ids.userId, announcementId: ids.announcementId, kind: 'announcement_created' })

    // MariaDB CHECK 위반은 errno 4025 (mysql2가 붙이는 code 이름은 MySQL 기준이라 errno · 제약 이름으로 본다)
    const checkViolation = { errno: 4025, message: /chk_notifications_one_target/ }
    await assert.rejects(insertNotification(db.pool, { userId: ids.userId }), checkViolation)
    await assert.rejects(insertNotification(db.pool, { userId: ids.userId, ...ids }), checkViolation)
  })

  it('사용자를 지우면 알림도 지워지고(CASCADE), 알림이 가리키는 공유 과제는 지울 수 없다', async () => {
    const ids = await seed(db.pool)
    await insertNotification(db.pool, { userId: ids.userId, assignmentId: ids.assignmentId })
    await db.pool.query('DELETE FROM user_assignments')

    await assert.rejects(db.pool.query('DELETE FROM assignments'), { code: 'ER_ROW_IS_REFERENCED_2' })
    await db.pool.execute('DELETE FROM users WHERE id = ?', [ids.userId])
    assert.equal(await db.countRows('notifications'), 0)
  })

  const guardedDowns = [
    ['알림 행', (ids) => insertNotification(db.pool, { userId: ids.userId, assignmentId: ids.assignmentId }), /notifications 테이블에 행이 있어/, '0018_create_notifications'],
    ['공지 본 값', () => db.pool.query("UPDATE user_announcements SET seen_content_hash = REPEAT('b', 64)"), /user_announcements의 본 값에 값이 있어/, '0017_add_user_announcement_seen'],
    ['과제 본 제목', () => db.pool.query("UPDATE user_assignments SET seen_title = '과제'"), /user_assignments.seen_title에 값이 있어/, '0016_add_user_assignment_seen_title'],
    ['Canvas 계정 id', () => db.pool.query("UPDATE lms_tokens SET canvas_user_id = '9001'"), /lms_tokens.canvas_user_id에 값이 있어/, FIRST_MIGRATION],
  ]
  for (const [label, makeData, message, stopsAt] of guardedDowns) {
    it(`되돌리기: ${label}이 있으면 그 번호에서 멈추고 값이 남는다 (데이터 보존)`, async () => {
      const ids = await seed(db.pool)
      await makeData(ids)

      await assert.rejects(migrator.down({ to: FIRST_MIGRATION }), message)

      const executed = (await migrator.executed()).map((m) => m.name)
      assert.equal(executed.at(-1), stopsAt, `${stopsAt}는 적용된 상태로 남아야 함`)
    })
  }

  it('값이 없으면 0018 → 0015 순서로 깨끗하게 되돌리고 다시 적용된다', async () => {
    await seed(db.pool)

    await migrator.down({ to: FIRST_MIGRATION })

    assert.equal((await columns(db.pool, 'lms_tokens')).canvas_user_id, undefined)
    assert.equal((await columns(db.pool, 'user_assignments')).seen_title, undefined)
    assert.deepEqual(await columns(db.pool, 'notifications'), {})
    await migrator.up({ to: LAST_MIGRATION })
    assert.ok((await columns(db.pool, 'notifications')).kind)
  })
})
