import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Umzug } from 'umzug'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))
const UP_SUFFIX = '.up.sql'
const DOWN_SUFFIX = '.down.sql'

// 실행된 마이그레이션 이름을 기록하는 표. 마이그레이션 도구 자신의 장부라 여기서 만든다.
const CREATE_STORAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(255) NOT NULL,
    executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`

function createStorage(pool) {
  const ready = pool.query(CREATE_STORAGE_TABLE)
  return {
    async executed() {
      await ready
      const [rows] = await pool.query('SELECT name FROM schema_migrations ORDER BY name')
      return rows.map((row) => row.name)
    },
    async logMigration({ name }) {
      await ready
      await pool.execute('INSERT INTO schema_migrations (name) VALUES (?)', [name])
    },
    async unlogMigration({ name }) {
      await ready
      await pool.execute('DELETE FROM schema_migrations WHERE name = ?', [name])
    },
  }
}

async function runSqlFile(pool, path) {
  const sql = await readFile(path, 'utf8')
  await pool.query(sql)
}

export function createMigrator(pool, { logger } = {}) {
  return new Umzug({
    migrations: {
      glob: [`*${UP_SUFFIX}`, { cwd: MIGRATIONS_DIR }],
      resolve: ({ name, path }) => ({
        name: name.slice(0, -UP_SUFFIX.length),
        up: () => runSqlFile(pool, path),
        down: () => runSqlFile(pool, path.slice(0, -UP_SUFFIX.length) + DOWN_SUFFIX),
      }),
    },
    storage: createStorage(pool),
    logger,
  })
}
