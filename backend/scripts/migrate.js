import 'dotenv/config'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { createPool } from '../src/db/pool.js'
import { createMigrator } from '../src/db/migrator.js'

const names = (migrations) => migrations.map((m) => m.name)

const COMMANDS = {
  up: async (migrator) => names(await migrator.up()),
  down: async (migrator) => names(await migrator.down()),
  status: async (migrator) => ({
    executed: names(await migrator.executed()),
    pending: names(await migrator.pending()),
  }),
}

const command = process.argv[2] ?? 'up'
if (!COMMANDS[command]) {
  console.error(`사용법: node scripts/migrate.js <${Object.keys(COMMANDS).join('|')}>`)
  process.exit(1)
}

const config = loadConfig()
const logger = createLogger({ level: config.logLevel })
const pool = createPool(config.db)
try {
  const result = await COMMANDS[command](createMigrator(pool, { logger }))
  logger.info({ command, database: config.db.database, result }, 'migration finished')
} catch (err) {
  logger.error({ command, err: { name: err.name, message: err.message } }, 'migration failed')
  process.exitCode = 1
} finally {
  await pool.end()
}
