// 동기화 실행기 (ADR 0008).
// - 주기 실행: 앱 안 setTimeout 연쇄. 한 번 끝난 뒤에야 다음을 예약해 겹치지 않는다. 첫 실행은 시작 직후가 아니라 한 주기 뒤.
// - 요청 실행(requestSync): 토큰 등록 직후 첫 동기화 · 수동 동기화. 응답을 기다리게 하지 않는 백그라운드.
// - 동시 실행 상한(concurrency): 위 둘을 합친 전체 동기화 수. DB 풀 크기와의 관계는 ADR 0008.
// 백그라운드 동기화는 절대 거부(reject)되지 않는다: 예상 밖 에러는 로그로 남기고 failed로 바꾼다.
import { createLimiter } from '../sync/limiter.js'

const DEFAULT_CONCURRENCY = 2
const DEFAULT_TIMERS = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (timer) => clearTimeout(timer),
}

// 상한을 지키며 한 사용자를 동기화한다. 동기화 안의 에러는 lmsSync가 잡아 failing으로 기록하므로,
// 여기까지 오는 것은 잠금 연결조차 못 얻은 경우 등(기록 불가)이다
function createSafeSync({ lmsSync, logger, limit }) {
  return (userId) =>
    limit(() => lmsSync.syncUser(userId)).catch((err) => {
      logger.error({ event: 'lms_sync_crashed', userId, err: { name: err?.name, code: err?.code } }, 'lms sync crashed')
      return { outcome: 'failed', errorCode: 'internal_error' }
    })
}

function countOutcome(summary, result) {
  const key = { applied: 'applied', failed: 'failed' }[result.outcome] ?? 'skipped'
  summary[key] += 1
}

// 주기 실행 한 번: 대상을 한 명씩 순서대로. 종료 중이면 지금 사용자까지만 하고 멈춘다
async function runTargets({ listTargets, safeSync, state, logger }) {
  const summary = { total: 0, applied: 0, failed: 0, skipped: 0 }
  let targets
  try {
    targets = await listTargets()
  } catch (err) {
    logger.error({ event: 'lms_sync_run_failed', err: { name: err?.name, code: err?.code } }, 'could not list sync targets')
    return summary
  }
  summary.total = targets.length
  for (const userId of targets) {
    if (state.stopped) {
      break
    }
    countOutcome(summary, await safeSync(userId))
  }
  logger.info({ event: 'lms_sync_run_finished', ...summary }, 'periodic lms sync finished')
  return summary
}

// 같은 사용자가 이미 돌고 있어 건너뛰면(토큰 교체 직후 등), 그 동기화가 끝난 뒤 한 번만 다시 돌린다
async function syncWithRetry({ lmsSync, safeSync }, userId) {
  const first = await safeSync(userId)
  if (first.reason !== 'already_running') {
    return first
  }
  await lmsSync.whenUserIdle?.(userId)
  return safeSync(userId)
}

// limit: 여러 실행기가 동시 실행 상한을 함께 지키도록 넘기는 제한기(src/sync/limiter.js). 없으면 concurrency로 이 실행기만의 제한기
export function createSyncRunner({ lmsSync, listTargets, intervalMs, logger, timers = DEFAULT_TIMERS, concurrency = DEFAULT_CONCURRENCY, limit = createLimiter(concurrency) }) {
  const safeSync = createSafeSync({ lmsSync, logger, limit })
  const inFlight = new Set()
  const state = { timer: null, running: null, stopped: false }
  const track = (promise) => {
    inFlight.add(promise)
    promise.then(() => inFlight.delete(promise))
    return promise
  }

  // 실행 중에 또 부르면 겹쳐 돌지 않고 { skipped: true }
  function runOnce() {
    if (state.running) {
      return Promise.resolve({ skipped: true })
    }
    state.running = track(runTargets({ listTargets, safeSync, state, logger })).finally(() => {
      state.running = null
    })
    return state.running
  }

  function schedule() {
    if (state.stopped) {
      return
    }
    state.timer = timers.setTimeout(async () => {
      state.timer = null
      await runOnce()
      schedule()
    }, intervalMs)
  }

  return {
    start: schedule,
    // 예약을 취소하고 새 실행 · 새 요청을 받지 않는다. 진행 중인 것은 whenIdle로 기다릴 수 있다
    stop() {
      state.stopped = true
      timers.clearTimeout(state.timer)
      state.timer = null
    },
    runOnce,
    requestSync: (userId) => (state.stopped ? Promise.resolve({ outcome: 'skipped', reason: 'shutting_down' }) : track(syncWithRetry({ lmsSync, safeSync }, userId))),
    async whenIdle() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight])
      }
    },
  }
}
