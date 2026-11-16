// 이름 있는 잠금 (ADR 0008 · 0010). 같은 작업(예: 한 사용자의 동기화)이 동시에 돌지 않게 MariaDB GET_LOCK(대기 0초)을 잡고 work를 실행한다.
// 잠금 이름 = DB 이름 + ':' + name (같은 MariaDB의 개발 · 테스트 DB끼리 겹치지 않게). 잠금은 연결에 붙어 있어 서버가 죽어도 남지 않는다.
// 결과: { acquired: false } 또는 { acquired: true, result }. work가 던지면 잠금을 풀고 그대로 던진다.
const GET_LOCK = "SELECT GET_LOCK(CONCAT(DATABASE(), ':', ?), 0) AS acquired"
const RELEASE_LOCK = "SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':', ?))"
const LOCK_ACQUIRED = 1

// 잠금 해제가 실패한 연결은 상태를 알 수 없으니 버린다(연결이 끊기면 서버가 잠금을 푼다)
async function releaseLockOrDestroy(connection, name) {
  try {
    await connection.query(RELEASE_LOCK, [name])
    return true
  } catch {
    connection.destroy()
    return false
  }
}

export async function withNamedLock(pool, name, work) {
  const connection = await pool.getConnection()
  let reusable = true
  try {
    const [[{ acquired }]] = await connection.query(GET_LOCK, [name])
    if (Number(acquired) !== LOCK_ACQUIRED) {
      return { acquired: false }
    }
    try {
      return { acquired: true, result: await work() }
    } finally {
      reusable = await releaseLockOrDestroy(connection, name)
    }
  } finally {
    if (reusable) {
      connection.release()
    }
  }
}
