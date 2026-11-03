import 'dotenv/config'
import { loadConfig } from '../../src/config.js'
import { createPool } from '../../src/db/pool.js'
import { createMigrator } from '../../src/db/migrator.js'

export const FRONTEND_URL = 'http://frontend.test'
// 로그에 새면 안 되는 값. 로그 검사 테스트에서 찾아본다.
export const TEST_CLIENT_SECRET = 'fake-client-secret-MUST-NOT-LEAK'
const TEST_DB_SUFFIX = '_test'
// 자식 → 부모 순서로 비워야 외래키에 걸리지 않는다
const TABLES_TO_RESET = ['auth_identities', 'users', 'sessions']

export function buildTestConfig() {
  const testDbName = process.env.TEST_DB_NAME
  if (!testDbName?.endsWith(TEST_DB_SUFFIX) || testDbName === process.env.DB_NAME) {
    throw new Error(`TEST_DB_NAME은 개발 DB와 다르고 '${TEST_DB_SUFFIX}'로 끝나야 함`)
  }
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DB_NAME: testDbName,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    FRONTEND_URL,
    KAKAO_REST_API_KEY: 'fake-rest-api-key',
    KAKAO_CLIENT_SECRET: TEST_CLIENT_SECRET,
    KAKAO_REDIRECT_URI: 'http://backend.test/api/auth/kakao/callback',
  })
}

// 테스트 DB에 연결하고 마이그레이션을 적용한다. 앱 모듈에는 의존하지 않는다.
export async function openTestDb(config = buildTestConfig()) {
  const pool = createPool(config.db)
  await createMigrator(pool).up()
  return {
    pool,
    resetDatabase: async () => {
      for (const table of TABLES_TO_RESET) {
        await pool.query('DELETE FROM ??', [table])
      }
    },
    countRows: async (table) => {
      const [rows] = await pool.query('SELECT COUNT(*) AS n FROM ??', [table])
      return Number(rows[0].n)
    },
  }
}
