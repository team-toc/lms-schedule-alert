// 트랜잭션 실행을 공유하는 경계 레이어 (계정 저장소 · LMS 저장소)

// 에러에서 원인 파악에 필요한 것만 꺼낸다 (SQL 값 등은 남기지 않음)
function describeError(err) {
  return { name: err.name, code: err.code, errno: err.errno, message: err.message }
}

// 롤백에 실패한 연결은 상태를 알 수 없으므로 풀에 돌려주지 않고 버린다.
// 버린 연결은 서버가 끊으면서 열린 트랜잭션을 롤백한다. 반환값: 연결을 다시 써도 되는지
async function rollbackOrDestroy(connection, { logger, originalError }) {
  try {
    await connection.rollback()
    return true
  } catch (rollbackError) {
    logger.error(
      {
        event: 'transaction_rollback_failed',
        rollbackError: describeError(rollbackError),
        originalError: describeError(originalError),
      },
      'transaction rollback failed, connection destroyed',
    )
    connection.destroy()
    return false
  }
}

// 트랜잭션 하나를 실행한다. 에러가 나면 롤백하고 원래 에러를 그대로 올린다(롤백이 실패해도 원래 에러).
// 롤백이 실패한 연결은 풀에 돌려주지 않고 버린다 (ADR 0004).
export async function runInTransaction({ pool, logger }, work) {
  const connection = await pool.getConnection()
  let reusable = true
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (err) {
    reusable = await rollbackOrDestroy(connection, { logger, originalError: err })
    throw err
  } finally {
    if (reusable) {
      connection.release()
    }
  }
}
