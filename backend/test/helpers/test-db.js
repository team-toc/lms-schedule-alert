import 'dotenv/config'
import { loadConfig } from '../../src/config.js'
import { createPool } from '../../src/db/pool.js'
import { createMigrator } from '../../src/db/migrator.js'
import { acquireMigrationLock } from './migration-lock.js'

export const FRONTEND_URL = 'http://frontend.test'
// 로그에 새면 안 되는 값. 로그 검사 테스트에서 찾아본다.
export const TEST_CLIENT_SECRET = 'fake-client-secret-MUST-NOT-LEAK'
export const TEST_GOOGLE_CLIENT_SECRET = 'fake-google-client-secret-MUST-NOT-LEAK'
// Google 클라이언트를 테스트에서 직접 만들 때 쓰는 설정 (config.google과 같은 모양)
export const GOOGLE_TEST_CONFIG = {
  clientId: 'fake-google-client-id.apps.googleusercontent.com',
  clientSecret: TEST_GOOGLE_CLIENT_SECRET,
  redirectUri: 'http://backend.test/api/auth/google/callback',
}
const TEST_DB_SUFFIX = '_test'
const DEFAULT_TEST_DB_NAME = 'lms_schedule_alert_test'
// 자식 → 부모 순서로 비워야 외래키에 걸리지 않는다
const TABLES_TO_RESET = ['password_credentials', 'auth_identities', 'users', 'sessions']

// 테스트가 환경(개발자 .env 또는 CI 환경변수)에서 읽는 값은 테스트 DB 접속 정보뿐이다.
// 그 밖의 설정(세션 · 제공자 키 · 프록시 · 실패 제한 등)은 아래에 고정해, 개발자 .env 내용에 따라 결과가 바뀌지 않게 한다.
const FIXED_TEST_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  FRONTEND_URL,
  KAKAO_REST_API_KEY: 'fake-rest-api-key',
  KAKAO_CLIENT_SECRET: TEST_CLIENT_SECRET,
  KAKAO_REDIRECT_URI: 'http://backend.test/api/auth/kakao/callback',
  GOOGLE_CLIENT_ID: GOOGLE_TEST_CONFIG.clientId,
  GOOGLE_CLIENT_SECRET: GOOGLE_TEST_CONFIG.clientSecret,
  GOOGLE_REDIRECT_URI: GOOGLE_TEST_CONFIG.redirectUri,
}

// 테스트 DB 접속에 쓰는 환경변수만 꺼낸다. DB_NAME(개발 DB)은 테스트 DB와 같은지 막는 검사에만 쓴다.
export function testDbConnectionEnv(env = process.env) {
  return {
    DB_HOST: env.DB_HOST || '127.0.0.1',
    DB_PORT: env.DB_PORT || '3306',
    DB_USER: env.DB_USER,
    DB_PASSWORD: env.DB_PASSWORD,
    TEST_DB_NAME: env.TEST_DB_NAME || DEFAULT_TEST_DB_NAME,
    ...(env.DB_NAME ? { DB_NAME: env.DB_NAME } : {}),
  }
}

export function buildTestConfig(env = process.env) {
  const { TEST_DB_NAME: testDbName, DB_NAME: devDbName, ...connection } = testDbConnectionEnv(env)
  if (!testDbName.endsWith(TEST_DB_SUFFIX) || testDbName === devDbName) {
    throw new Error(`TEST_DB_NAME은 개발 DB와 다르고 '${TEST_DB_SUFFIX}'로 끝나야 함`)
  }
  return loadConfig({ ...FIXED_TEST_ENV, ...connection, DB_NAME: testDbName })
}

// 테스트 DB에 연결하고 마이그레이션 잠금을 잡은 채 마이그레이션을 적용한다. 앱 모듈에는 의존하지 않는다.
// holdMigrationLock: 마이그레이션을 되돌리는 테스트는 true로 잠금을 계속 들고 있다가 끝날 때 releaseMigrationLock을 부른다.
export async function openTestDb(config = buildTestConfig(), { holdMigrationLock = false } = {}) {
  const pool = createPool(config.db)
  let releaseMigrationLock
  try {
    releaseMigrationLock = await acquireMigrationLock(pool, config.db.database)
    await createMigrator(pool).up()
  } catch (err) {
    await releaseMigrationLock?.()
    await pool.end()
    throw err
  }
  if (!holdMigrationLock) {
    await releaseMigrationLock()
  }
  return {
    pool,
    releaseMigrationLock,
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
