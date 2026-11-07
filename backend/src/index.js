import 'dotenv/config'
import { loadConfig, ConfigError } from './config.js'
import { createLogger } from './logger.js'
import { createPool } from './db/pool.js'
import { createSessionStore } from './session.js'
import { createKakaoClient } from './kakao/kakao-client.js'
import { createGoogleClient } from './google/google-client.js'
import { createApp } from './app.js'

function loadConfigOrExit() {
  try {
    return loadConfig()
  } catch (err) {
    if (!(err instanceof ConfigError)) {
      throw err
    }
    // 메시지에는 키 이름만 있고 값은 없다
    console.error(`설정 오류: ${err.message}`)
    process.exit(1)
  }
}

const config = loadConfigOrExit()
const logger = createLogger({ level: config.logLevel })
if (config.isProduction && !config.trustProxy) {
  logger.warn({ event: 'trust_proxy_disabled' }, 'production without TRUST_PROXY: Secure cookies are not issued behind a proxy')
}

const pool = createPool(config.db)
const sessionStore = createSessionStore(pool, { ttlMs: config.session.ttlMs })
const kakaoClient = createKakaoClient({ config: config.kakao })
const googleClient = createGoogleClient({ config: config.google })
const app = createApp({ config, logger, pool, kakaoClient, googleClient, sessionStore })

app.listen(config.port, () => {
  logger.info({ port: config.port, trustProxy: config.trustProxy }, 'backend started')
})
