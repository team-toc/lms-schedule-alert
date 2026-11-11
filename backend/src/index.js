import 'dotenv/config'
import { loadConfigOrExit } from './config.js'
import { createLogger } from './logger.js'
import { createPool } from './db/pool.js'
import { createSessionStore } from './session.js'
import { createKakaoClient } from './kakao/kakao-client.js'
import { createGoogleClient } from './google/google-client.js'
import { createPasswordHasher } from './email/password-hasher.js'
import { createDummyPasswordHash } from './accounts/email-account-service.js'
import { createApp } from './app.js'

const config = loadConfigOrExit()
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
const app = createApp({ config, logger, pool, kakaoClient, googleClient, sessionStore, passwordHasher, dummyPasswordHash })

app.listen(config.port, () => {
  logger.info({ port: config.port, trustProxy: config.trustProxy }, 'backend started')
})
