import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openTestDb, buildTestConfig, testDbConnectionEnv } from './helpers/test-db.js'
import { childProcessEnv } from './helpers/child-env.js'

const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url))
const PROCESS_TIMEOUT_MS = 30000
const EXPECTED_LAST_MIGRATION = '0007_add_email_provider'

function runReset(envOverrides = {}) {
  return spawnSync(process.execPath, ['scripts/reset-test-db.js'], {
    cwd: BACKEND_DIR,
    // 테스트 DB 접속 정보만 넘기고 개발자 .env는 읽지 않게 한다
    env: childProcessEnv({ ...testDbConnectionEnv(), ...envOverrides }),
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
  })
}

async function migrationNames(pool, database) {
  const [rows] = await pool.query('SELECT name FROM ??.schema_migrations ORDER BY name', [database])
  return rows.map((r) => r.name)
}

describe('npm run test:db:reset', () => {
  it('TEST_DB_NAME이 _test로 끝나지 않으면 DB에 손대지 않고 거부한다', () => {
    const result = runReset({ TEST_DB_NAME: 'lms_schedule_alert_prod' })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /^테스트 DB 초기화 거부: TEST_DB_NAME은 개발 DB와 다르고 '_test'로 끝나야 함\n$/)
    assert.equal(result.stdout, '')
  })

  it('TEST_DB_NAME이 개발 DB(DB_NAME)와 같으면 거부한다', () => {
    const result = runReset({ TEST_DB_NAME: 'same_name_test', DB_NAME: 'same_name_test' })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /^테스트 DB 초기화 거부:/)
  })

  it('테스트 DB를 비우고 0001부터 다시 적용한다 (데이터 · 꼬인 기록 모두 정리)', async () => {
    const db = await openTestDb()
    const database = buildTestConfig().db.database
    try {
      await db.pool.execute('INSERT INTO users (display_name) VALUES (?)', ['지워질 사용자'])
      // 지난번처럼 기록이 꼬인 상태를 흉내 낸다: 0004 기록을 지운다
      await db.pool.execute('DELETE FROM schema_migrations WHERE name = ?', ['0004_add_google_provider'])

      const result = runReset()

      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, new RegExp(`마이그레이션 \\d+개 적용 \\(${EXPECTED_LAST_MIGRATION}까지\\)`))
      const names = await migrationNames(db.pool, database)
      assert.equal(names[0], '0001_create_users')
      assert.ok(names.includes('0004_add_google_provider'))
      assert.equal(names.at(-1), EXPECTED_LAST_MIGRATION)
      assert.equal(await db.countRows('users'), 0)
    } finally {
      await db.pool.end()
    }
  })
})
