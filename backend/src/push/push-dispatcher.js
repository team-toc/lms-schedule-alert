// 백그라운드 푸시 발송기 (ADR 0012). 동기화의 사용자 잠금을 푼 뒤 보낸다(느린 푸시 서비스가 동기화 자리를 잡지 않게).
// - 동시 실행은 기존 제한기(createLimiter, 기본 4). 대기열은 버릴 수 있게 따로 둔다: 일감은 하나씩 넣으며 빈 자리가 있으면 바로 시작,
//   대기가 maxPending을 넘으면 가장 오래된 대기 일감부터 버리고 버린 개수만 경고
// - 보내기 직전 구독 행을 id로 다시 읽어 user_id · endpoint_hash가 넣을 때와 같을 때만, 그 행의 최신 키로(주인이 바뀌었으면 안 보냄)
// - 결과 기록(성공 · 실패 횟수 · 404/410 삭제)은 id와 해시가 둘 다 맞을 때만. 연속 실패 5번에 닿는 순간 경고 한 번
// - 로그에는 사용자 id · 개수 · 결과 코드만(endpoint · 키 · 내용 없음). 일감 하나의 예외는 그 일감만 실패로
import { createLimiter } from '../sync/limiter.js'

export const MAX_PENDING_PUSHES = 1000
export const PUSH_CONCURRENCY = 4
export const FAILING_WARN_AT = 5

// 넣은 묶음(동기화 하나 · 테스트 발송 하나)마다 결과를 모아 끝나면 한 줄
function createBatch(logger, userId, size) {
  const counts = { sent: 0, expired: 0, failed: 0, skipped: 0, dropped: 0 }
  let remaining = size
  return {
    done(kind) {
      counts[kind] += 1
      remaining -= 1
      if (remaining === 0) {
        logger.info({ event: 'push_sent', userId, ...counts }, 'push batch finished')
      }
    },
  }
}

// 일감 하나: 다시 읽어 주인 확인 → 최신 키로 보내기 → 결과 기록. 결과: 'sent' | 'expired' | 'failed' | 'skipped'
function createJobRunner({ sender, repository, cipher, logger, now }) {
  async function record(job, result) {
    const where = { id: job.subscriptionId, endpointHash: job.endpointHash }
    if (result.outcome === 'sent') {
      await repository.recordSuccess({ ...where, at: now() })
      return 'sent'
    }
    if (result.outcome === 'expired') {
      await repository.deleteExpired(where)
      return 'expired'
    }
    const failures = await repository.recordFailure({ ...where, code: result.code })
    if (failures === FAILING_WARN_AT) {
      logger.warn({ event: 'push_subscription_failing', userId: job.userId, failures }, 'push subscription keeps failing')
    }
    return 'failed'
  }

  return async function run(job) {
    const row = await repository.findById(job.subscriptionId)
    if (!row || row.userId !== job.userId || row.endpointHash !== job.endpointHash) {
      return 'skipped'
    }
    const subscription = JSON.parse(cipher.decrypt(row.subscriptionEnc, { userId: row.userId }))
    return record(job, await sender.send(subscription, job.payload, { topic: job.topic }))
  }
}

// 버릴 수 있는 대기열 + 기존 제한기로 동시 실행. add는 넣고 빈 자리가 있으면 바로 시작하며, 넘친 오래된 대기 일감을 돌려준다
function createWorkQueue({ execute, concurrency, maxPending }) {
  const limit = createLimiter(concurrency)
  const pending = []
  const running = new Set()
  let inFlight = 0

  function pump() {
    while (inFlight < concurrency && pending.length > 0) {
      const job = pending.shift()
      inFlight += 1
      const task = limit(() => execute(job)).finally(() => {
        inFlight -= 1
        running.delete(task)
        pump()
      })
      running.add(task)
    }
  }

  return {
    add(job) {
      pending.push(job)
      pump()
      return pending.length > maxPending ? pending.splice(0, pending.length - maxPending) : []
    },
    async whenIdle() {
      while (running.size > 0 || pending.length > 0) {
        if (running.size === 0) pump()
        await Promise.allSettled([...running])
      }
    },
    pendingCount: () => pending.length,
  }
}

export function createPushDispatcher({ sender, repository, cipher, logger, now, concurrency = PUSH_CONCURRENCY, maxPending = MAX_PENDING_PUSHES }) {
  const run = createJobRunner({ sender, repository, cipher, logger, now })
  // 일감 하나의 예외(DB 등)는 그 일감만 실패로, 묶음 결과에 센다
  const execute = (job) =>
    run(job)
      .catch((err) => {
        logger.error({ event: 'push_dispatch_failed', userId: job.userId, err: { name: err?.name, code: err?.code } }, 'push job failed')
        return 'failed'
      })
      .then((kind) => job.batch.done(kind))
  const queue = createWorkQueue({ execute, concurrency, maxPending })
  let stopped = false

  // jobs: [{ subscriptionId, userId, endpointHash, payload, topic }]
  function enqueue(jobs) {
    if (stopped || jobs.length === 0) return
    const batch = createBatch(logger, jobs[0].userId, jobs.length)
    let dropped = 0
    for (const job of jobs) {
      for (const old of queue.add({ ...job, batch })) {
        old.batch.done('dropped')
        dropped += 1
      }
    }
    if (dropped > 0) {
      logger.warn({ event: 'push_queue_overflow', dropped }, 'push queue full, oldest pending pushes dropped')
    }
  }

  return {
    enqueue,
    whenIdle: queue.whenIdle,
    pendingCount: queue.pendingCount,
    start: () => {
      stopped = false
    },
    // 종료: 새 일감을 받지 않는다(진행 중 · 대기 중인 것은 whenIdle로 기다림, 기존 종료 대기 안에서)
    stop: () => {
      stopped = true
    },
  }
}
