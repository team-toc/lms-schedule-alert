// 서버 종료(SIGTERM · SIGINT) 처리 (ADR 0008).
// 1) 주기 실행기를 멈춘다(새 주기 · 새 동기화 요청을 받지 않음, 진행 중인 주기는 지금 사용자까지만)
// 2) 새 HTTP 연결을 받지 않는다
// 3) 진행 중인 동기화를 최대 graceMs 기다린다. 그 안에 끝나면 정상 반영된 것이고, 못 끝나면 기다리지 않고 종료한다.
//    반영은 한 트랜잭션이라 커밋 전에 프로세스가 끝나면 DB가 롤백한다(부분 반영 없음). 다음 시작 후 주기에 다시 처리된다.
const SHUTDOWN_GRACE_MS = 10000
const DEFAULT_TIMERS = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (timer) => clearTimeout(timer) }

// promise가 ms 안에 끝나면 true, 아니면 false
function settlesWithin(promise, ms, timers) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = timers.setTimeout(() => resolve(false), ms)
  })
  return Promise.race([promise.then(() => true), timeout]).finally(() => timers.clearTimeout(timer))
}

export function createShutdown({ server, syncRunner, pool, logger, exit = process.exit, graceMs = SHUTDOWN_GRACE_MS, timers = DEFAULT_TIMERS }) {
  let started = null

  async function run(signal) {
    logger.info({ event: 'shutdown_started', signal }, 'shutting down')
    syncRunner.stop()
    server.close()
    const finished = await settlesWithin(syncRunner.whenIdle(), graceMs, timers)
    if (finished) {
      await pool.end()
      logger.info({ event: 'shutdown_finished' }, 'shut down')
    } else {
      // 연결을 정리하지 않고 끝낸다: 진행 중이던 반영 트랜잭션은 연결이 끊기며 롤백된다
      logger.warn({ event: 'shutdown_syncs_abandoned', graceMs }, 'in-progress syncs did not finish in time; exiting without applying them')
    }
    exit(0)
  }

  // 신호가 여러 번 와도 한 번만 처리한다
  return function shutdown(signal) {
    started ??= run(signal)
    return started
  }
}
