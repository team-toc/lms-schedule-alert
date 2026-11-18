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
import { loadClassPeriodsOrExit } from './suggestions/class-periods.js'
import { loadPushConfigOrExit } from './push/push-config.js'
import { createApp } from './app.js'
import { createShutdown } from './shutdown.js'

const config = loadConfigOrExit()
// Canvas 설정(주소 · 토큰 암호화 키)은 서버에만 필요하다. DB에 연결하기 전에 검사해 틀리면 키 이름만 출력하고 종료 (ADR 0008)
const lmsConfig = loadLmsConfigOrExit(process.env, { isProduction: config.isProduction })
// 브라우저 푸시 VAPID 키(ADR 0012). 없거나 틀리면 키 이름만 출력하고 종료
const pushConfig = loadPushConfigOrExit(process.env)
// 교시 시간표(공지 일정 제안의 "N교시" → 시각, ADR 0011). 틀리면 DB에 연결하기 전에 종료
const classPeriods = await loadClassPeriodsOrExit(new URL('../config/class-periods.json', import.meta.url))
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
const lmsServices = createLmsServices({ pool, logger, lmsConfig, classPeriods, push: { config: pushConfig } })
const app = createApp({ config, logger, pool, kakaoClient, googleClient, sessionStore, passwordHasher, dummyPasswordHash, lmsServices })
// Canvas · iCloud 두 실행기를 함께 시작 · 정지 · 대기 (shutdown.js는 실행기 하나처럼 다룬다)
const runners = [lmsServices.syncRunner, lmsServices.calendarSyncRunner]
const allRunners = {
  start: () => runners.forEach((runner) => runner.start()),
  stop: () => runners.forEach((runner) => runner.stop()),
  whenIdle: () => Promise.all(runners.map((runner) => runner.whenIdle())),
}

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, trustProxy: config.trustProxy }, 'backend started')
  // 첫 주기 동기화는 시작 직후가 아니라 한 주기 뒤 (배포 · 재시작마다 Canvas · iCloud에 몰아서 요청하지 않게)
  allRunners.start()
})

const shutdown = createShutdown({ server, syncRunner: allRunners, pool, logger })
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
