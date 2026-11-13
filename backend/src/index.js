import 'dotenv/config'
import { loadConfigOrExit } from './config.js'
import { loadLmsConfigOrExit } from './lms/lms-config.js'
import { createLogger } from './logger.js'
import { createPool } from './db/pool.js'
import { createSessionStore } from './session.js'
import { createKakaoClient } from './kakao/kakao-client.js'
import { createGoogleClient } from './google/google-client.js'
import { createPasswordHasher } from './email/password-hasher.js'
import { createDummyPasswordHash } from './accounts/email-account-service.js'
import { createLmsServices } from './lms/lms-services.js'
import { createApp } from './app.js'
import { createShutdown } from './shutdown.js'

const config = loadConfigOrExit()
// Canvas 설정(주소 · 토큰 암호화 키)은 서버에만 필요하다. DB에 연결하기 전에 검사해 틀리면 키 이름만 출력하고 종료 (ADR 0008)
const lmsConfig = loadLmsConfigOrExit(process.env, { isProduction: config.isProduction })
const logger = createLogger({ level: config.logLevel })
if (config.isProduction && !config.trustProxy) {
  logger.warn({ event: 'trust_proxy_disabled' }, 'production without TRUST_PROXY: Secure cookies are not issued behind a proxy')
}

const pool = createPool(config.db)
const sessionStore = createSessionStore(pool, { ttlMs: config.session.ttlMs })
const kakaoClient = createKakaoClient({ config: config.kakao })
const googleClient = createGoogleClient({ config: config.google })
// 없는 이메일 로그인용 가짜 해시: 실제 해시와 같은 모듈 · 파라미터로 시작할 때 한 번만 만든다 (ADR 0007)
const passwordHasher = createPasswordHasher()
const dummyPasswordHash = await createDummyPasswordHash(passwordHasher)
const lmsServices = createLmsServices({ pool, logger, lmsConfig })
const app = createApp({ config, logger, pool, kakaoClient, googleClient, sessionStore, passwordHasher, dummyPasswordHash, lmsServices })

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, trustProxy: config.trustProxy }, 'backend started')
  // 첫 주기 동기화는 시작 직후가 아니라 한 주기 뒤 (배포 · 재시작마다 Canvas에 몰아서 요청하지 않게)
  lmsServices.syncRunner.start()
})

const shutdown = createShutdown({ server, syncRunner: lmsServices.syncRunner, pool, logger })
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
