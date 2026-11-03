import { createLogger } from '../../src/logger.js'
import { createSessionStore } from '../../src/session.js'
import { createApp } from '../../src/app.js'
import { buildTestConfig, openTestDb } from './test-db.js'

export { FRONTEND_URL, TEST_CLIENT_SECRET } from './test-db.js'

// 테스트 파일 하나가 쓰는 DB 연결 · 앱. before/after에서 열고 닫는다.
export async function openTestContext() {
  const baseConfig = buildTestConfig()
  const db = await openTestDb(baseConfig)
  const silentLogger = createLogger({ level: 'silent' })
  // express-session은 미들웨어마다 저장소에 리스너를 붙이므로, 앱마다 저장소를 따로 만들고 끝에 모두 닫는다
  const sessionStores = []

  function buildApp(kakaoClient, { userRepository, logger = silentLogger, config = baseConfig } = {}) {
    const sessionStore = createSessionStore(db.pool, { ttlMs: config.session.ttlMs, clearExpired: false })
    sessionStores.push(sessionStore)
    return createApp({ config, logger, pool: db.pool, kakaoClient, sessionStore, userRepository })
  }

  return {
    ...db,
    config: baseConfig,
    silentLogger,
    // overrides: userRepository(동시성 관찰용 래퍼), logger(로그 검사용), config(운영 설정 흉내)
    buildApp,
    close: async () => {
      await Promise.all(sessionStores.map((store) => store.close()))
      await db.pool.end()
    },
  }
}
