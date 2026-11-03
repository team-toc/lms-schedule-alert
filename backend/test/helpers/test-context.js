import { createLogger } from '../../src/logger.js'
import { createSessionStore } from '../../src/session.js'
import { createApp } from '../../src/app.js'
import { buildTestConfig, openTestDb } from './test-db.js'

export { FRONTEND_URL, TEST_CLIENT_SECRET } from './test-db.js'

// 테스트 파일 하나가 쓰는 DB 연결 · 세션 저장소 · 앱. before/after에서 열고 닫는다.
export async function openTestContext() {
  const config = buildTestConfig()
  const db = await openTestDb(config)
  const sessionStore = createSessionStore(db.pool, { clearExpired: false })
  const silentLogger = createLogger({ level: 'silent' })

  return {
    ...db,
    config,
    // overrides: userRepository(동시성 관찰용 래퍼), logger(로그 검사용)를 바꿔 끼울 수 있다
    buildApp: (kakaoClient, { userRepository, logger = silentLogger } = {}) =>
      createApp({ config, logger, pool: db.pool, kakaoClient, sessionStore, userRepository }),
    close: async () => {
      await sessionStore.close()
      await db.pool.end()
    },
  }
}
