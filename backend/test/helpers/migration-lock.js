// 테스트 DB의 마이그레이션(적용 · 되돌리기)을 한 번에 하나만 하게 하는 MariaDB 이름 잠금.
// GET_LOCK은 연결 단위라 잠금을 잡은 연결을 해제할 때까지 따로 들고 있는다.
const NO_WAIT_SECONDS = 0

export class MigrationLockBusyError extends Error {
  constructor(lockName) {
    super(`다른 테스트가 마이그레이션 중이라 시작하지 않음 (잠금: ${lockName}). 테스트는 npm test로 하나씩 실행할 것`)
    this.name = 'MigrationLockBusyError'
  }
}

function lockNameFor(database) {
  return `${database}:migrations`
}

// 바로 못 잡으면 기다리지 않고 MigrationLockBusyError. 반환값: 잠금을 푸는 함수(여러 번 불러도 안전)
export async function acquireMigrationLock(pool, database) {
  const lockName = lockNameFor(database)
  const connection = await pool.getConnection()
  const [[row]] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, NO_WAIT_SECONDS])
  if (row.acquired !== 1) {
    connection.release()
    throw new MigrationLockBusyError(lockName)
  }
  let released = false
  return async function releaseMigrationLock() {
    if (released) {
      return
    }
    released = true
    try {
      await connection.query('SELECT RELEASE_LOCK(?)', [lockName])
    } finally {
      connection.release()
    }
  }
}
