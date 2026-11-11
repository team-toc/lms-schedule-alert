import { createLogger } from '../../src/logger.js'
import { createSessionStore } from '../../src/session.js'
import { createApp } from '../../src/app.js'
import { createPasswordHasher } from '../../src/email/password-hasher.js'
import { createDummyPasswordHash } from '../../src/accounts/email-account-service.js'
import { buildTestConfig, openTestDb } from './test-db.js'

export { FRONTEND_URL, TEST_CLIENT_SECRET, TEST_GOOGLE_CLIENT_SECRET, GOOGLE_TEST_CONFIG } from './test-db.js'

// Google을 쓰지 않는 테스트(카카오 등)의 기본값. 호출되면 테스트가 실패하도록 던진다.
const unusedGoogleClient = {
  buildAuthorizeUrl() {
    throw new Error('이 테스트는 Google 클라이언트를 쓰지 않아야 함')
  },
  async exchangeCodeForProfile() {
    throw new Error('이 테스트는 Google 클라이언트를 쓰지 않아야 함')
  },
}

// 테스트 파일 하나가 쓰는 DB 연결 · 앱. before/after에서 열고 닫는다.
export async function openTestContext() {
  const baseConfig = buildTestConfig()
  const db = await openTestDb(baseConfig)
  const silentLogger = createLogger({ level: 'silent' })
  // 없는 이메일용 가짜 해시: 실제 서버처럼 시작할 때(파일마다) 한 번만 만든다
  const dummyPasswordHash = await createDummyPasswordHash(createPasswordHasher())
  // express-session은 미들웨어마다 저장소에 리스너를 붙이므로, 앱마다 저장소를 따로 만들고 끝에 모두 닫는다
  const sessionStores = []

  function buildApp(kakaoClient, overrides = {}) {
    const { googleClient = unusedGoogleClient, userRepository, logger = silentLogger, config = baseConfig } = overrides
    // 이메일 로그인: passwordHasher(호출 감시), loginThrottle(주입한 시계). 없으면 앱 기본값
    const { passwordHasher, loginThrottle } = overrides
    const sessionStore = createSessionStore(db.pool, { ttlMs: config.session.ttlMs, clearExpired: false })
    sessionStores.push(sessionStore)
    return createApp({
      config,
      logger,
      pool: db.pool,
      kakaoClient,
      googleClient,
      sessionStore,
      userRepository,
      passwordHasher,
      loginThrottle,
      dummyPasswordHash,
    })
  }

  return {
    ...db,
    config: baseConfig,
    silentLogger,
    // overrides: googleClient, userRepository(동시성 관찰용 래퍼), logger(로그 검사용), config(운영 설정 흉내)
    buildApp,
    close: async () => {
      await Promise.all(sessionStores.map((store) => store.close()))
      await db.pool.end()
    },
  }
}
