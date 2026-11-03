import 'dotenv/config'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createPool } from './db/pool.js'
import { createApp } from './app.js'

const config = loadConfig()
const logger = createLogger({ level: config.logLevel })
const pool = createPool(config.db)
const app = createApp({ config, logger, pool })

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'backend started')
})
