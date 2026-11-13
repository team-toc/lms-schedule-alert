import { createLogger } from '../../src/logger.js'
import { createSessionStore } from '../../src/session.js'
import { createApp } from '../../src/app.js'
import { createPasswordHasher } from '../../src/email/password-hasher.js'
import { createDummyPasswordHash } from '../../src/accounts/email-account-service.js'
import { createLmsServices } from '../../src/lms/lms-services.js'
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

// Canvas를 쓰지 않는 테스트의 기본값. Canvas로 요청이 나가면 테스트가 실패하도록 던진다.
const unusedCanvasFetch = async () => {
  throw new Error('이 테스트는 Canvas를 쓰지 않아야 함')
}
const UNUSED_LMS_CONFIG = { canvasBaseUrl: 'https://canvas.unused.test', tokenKey: Buffer.alloc(32), syncIntervalMs: 30 * 60 * 1000 }

function createUnusedLmsServices(pool, logger) {
  return createLmsServices({ pool, logger, lmsConfig: UNUSED_LMS_CONFIG, fetchFn: unusedCanvasFetch, now: () => new Date() })
}

// buildApp(kakaoClient, overrides): 앱 하나를 만든다. 만든 세션 저장소 · Canvas 서비스는 shared에 모아 끝에 정리한다.
// overrides: googleClient, userRepository(동시성 관찰용 래퍼), logger(로그 검사용), config(운영 설정 흉내),
// passwordHasher(호출 감시), loginThrottle(주입한 시계), lmsServices(가짜 Canvas · 시계를 끼운 것, helpers/lms-context.js)
function createAppBuilder({ db, baseConfig, silentLogger, dummyPasswordHash, shared }) {
  return function buildApp(kakaoClient, overrides = {}) {
    const { googleClient = unusedGoogleClient, userRepository, logger = silentLogger, config = baseConfig } = overrides
    const { passwordHasher, loginThrottle } = overrides
    // Canvas를 쓰지 않는 테스트는 Canvas로 요청이 나가는 순간 실패하는 기본값
    const lmsServices = overrides.lmsServices ?? createUnusedLmsServices(db.pool, logger)
    const sessionStore = createSessionStore(db.pool, { ttlMs: config.session.ttlMs, clearExpired: false })
    shared.sessionStores.push(sessionStore)
    shared.lmsInstances.push(lmsServices)
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
      lmsServices,
    })
  }
}

// 테스트 파일 하나가 쓰는 DB 연결 · 앱. before/after에서 열고 닫는다.
export async function openTestContext() {
  const baseConfig = buildTestConfig()
  const db = await openTestDb(baseConfig)
  const silentLogger = createLogger({ level: 'silent' })
  // 없는 이메일용 가짜 해시: 실제 서버처럼 시작할 때(파일마다) 한 번만 만든다
  const dummyPasswordHash = await createDummyPasswordHash(createPasswordHasher())
  // express-session은 미들웨어마다 저장소에 리스너를 붙이므로, 앱마다 저장소를 따로 만들고 끝에 모두 닫는다.
  // Canvas 서비스는 DB를 비우거나 닫기 전에 백그라운드 동기화가 끝나기를 기다린다(테스트 사이 누수 방지, 한 곳에서 처리).
  const shared = { sessionStores: [], lmsInstances: [] }
  const waitForBackgroundSyncs = () => Promise.all(shared.lmsInstances.map((lms) => lms.syncRunner.whenIdle()))

  return {
    ...db,
    resetDatabase: async () => {
      await waitForBackgroundSyncs()
      await db.resetDatabase()
    },
    config: baseConfig,
    silentLogger,
    buildApp: createAppBuilder({ db, baseConfig, silentLogger, dummyPasswordHash, shared }),
    close: async () => {
      await waitForBackgroundSyncs()
      await Promise.all(shared.sessionStores.map((store) => store.close()))
      await db.pool.end()
    },
  }
}
