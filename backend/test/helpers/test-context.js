import 'dotenv/config'
import { loadConfig } from '../../src/config.js'
import { createLogger } from '../../src/logger.js'
import { createPool } from '../../src/db/pool.js'
import { createMigrator } from '../../src/db/migrator.js'
import { createSessionStore } from '../../src/session.js'
import { createApp } from '../../src/app.js'

export const FRONTEND_URL = 'http://frontend.test'
// 로그에 새면 안 되는 값. 로그 검사 테스트에서 찾아본다.
export const TEST_CLIENT_SECRET = 'fake-client-secret-MUST-NOT-LEAK'
const TEST_DB_SUFFIX = '_test'
// 자식 → 부모 순서로 비워야 외래키에 걸리지 않는다
const TABLES_TO_RESET = ['auth_identities', 'users', 'sessions']

function buildTestConfig() {
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

// 테스트 파일 하나가 쓰는 DB 연결 · 세션 저장소. before/after에서 열고 닫는다.
export async function openTestContext() {
  const config = buildTestConfig()
  const pool = createPool(config.db)
  await createMigrator(pool).up()
  const sessionStore = createSessionStore(pool, { clearExpired: false })
  const silentLogger = createLogger({ level: 'silent' })

  return {
    pool,
    config,
    // overrides: userRepository(동시성 관찰용 래퍼), logger(로그 검사용)를 바꿔 끼울 수 있다
    buildApp: (kakaoClient, { userRepository, logger = silentLogger } = {}) =>
      createApp({ config, logger, pool, kakaoClient, sessionStore, userRepository }),
    resetDatabase: async () => {
      for (const table of TABLES_TO_RESET) {
        await pool.query('DELETE FROM ??', [table])
      }
    },
    countRows: async (table) => {
      const [rows] = await pool.query('SELECT COUNT(*) AS n FROM ??', [table])
      return Number(rows[0].n)
    },
    close: async () => {
      await sessionStore.close()
      await pool.end()
    },
  }
}
