// 테스트 DB만 비우고 0001부터 다시 적용한다. DB 이름이 _test로 끝나지 않거나 개발 DB와 같으면 거부한다.
import { buildTestConfig } from '../test/helpers/test-db.js'
import { acquireMigrationLock } from '../test/helpers/migration-lock.js'
import { createPool } from '../src/db/pool.js'
import { createMigrator } from '../src/db/migrator.js'

async function dropAllTables(pool) {
  const connection = await pool.getConnection()
  try {
    const [tables] = await connection.query(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
    )
    await connection.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const { name } of tables) {
      await connection.query('DROP TABLE ??', [name])
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1')
    return tables.length
  } finally {
    connection.release()
  }
}

let config
try {
  config = buildTestConfig()
} catch (err) {
  console.error(`테스트 DB 초기화 거부: ${err.message}`)
  process.exit(1)
}

const pool = createPool(config.db)
let releaseMigrationLock
try {
  releaseMigrationLock = await acquireMigrationLock(pool, config.db.database)
  const dropped = await dropAllTables(pool)
  const applied = (await createMigrator(pool).up()).map((m) => m.name)
  console.log(`테스트 DB ${config.db.database}: 테이블 ${dropped}개 삭제, 마이그레이션 ${applied.length}개 적용 (${applied.at(-1)}까지)`)
} catch (err) {
  console.error(`테스트 DB 초기화 실패: ${err.message}`)
  process.exitCode = 1
} finally {
  await releaseMigrationLock?.()
  await pool.end()
}
