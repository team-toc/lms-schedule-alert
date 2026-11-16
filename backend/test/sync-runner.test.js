import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { createSyncRunner } from '../src/lms/sync-runner.js'

const INTERVAL_MS = 30 * 60 * 1000
const silentLogger = pino({ level: 'silent' })

// 실제 타이머 대신 예약만 기록하고, 테스트가 fire()로 실행한다
function createFakeTimers() {
  const scheduled = []
  return {
    scheduled,
    timers: {
      setTimeout(fn, ms) {
        const timer = { fn, ms, cleared: false }
        scheduled.push(timer)
        return timer
      },
      clearTimeout(timer) {
        if (timer) {
          timer.cleared = true
        }
      },
    },
    pending: () => scheduled.filter((t) => !t.cleared && !t.fired),
    async fire() {
      const [timer] = scheduled.filter((t) => !t.cleared && !t.fired)
      timer.fired = true
      await timer.fn()
    },
  }
}

// 사용자별 결과를 정해 둘 수 있는 가짜 동기화. 동시에 몇 개가 돌고 있는지 기록한다
function createFakeSync(outcomes = {}) {
  const calls = []
  let running = 0
  let maxRunning = 0
  return {
    calls,
    maxRunning: () => maxRunning,
    async syncUser(userId) {
      calls.push(userId)
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await new Promise((resolve) => setImmediate(resolve))
      running -= 1
      const outcome = outcomes[userId]
      if (outcome instanceof Error) {
        throw outcome
      }
      return outcome ?? { outcome: 'applied' }
    },
  }
}

describe('주기 동기화 실행기 (앱 안 setTimeout 연쇄)', () => {
  let fake
  let sync

  beforeEach(() => {
    fake = createFakeTimers()
    sync = createFakeSync({ 2: { outcome: 'failed', errorCode: 'canvas_unavailable' }, 3: new Error('unexpected') })
  })

  function runner(listTargets = async () => [1, 2, 3, 4]) {
    return createSyncRunner({ lmsSync: sync, listTargets, intervalMs: INTERVAL_MS, logger: silentLogger, timers: fake.timers })
  }

  it('start(): 바로 실행하지 않고 주기(LMS_SYNC_INTERVAL_MINUTES) 뒤로 한 번 예약한다', () => {
    runner().start()

    assert.equal(fake.pending().length, 1)
    assert.equal(fake.pending()[0].ms, INTERVAL_MS)
    assert.equal(sync.calls.length, 0)
  })

  it('예약이 실행되면 대상 사용자를 한 명씩 순서대로 동기화하고(동시 1개), 끝난 뒤에야 다음을 예약한다', async () => {
    runner().start()

    await fake.fire()

    assert.deepEqual(sync.calls, [1, 2, 3, 4])
    assert.equal(sync.maxRunning(), 1)
    assert.equal(fake.pending().length, 1, '끝난 뒤 다음 실행 하나만 예약')
    assert.equal(fake.pending()[0].ms, INTERVAL_MS)
  })

  it('한 사용자가 실패하거나 예외를 던져도 나머지는 계속, 요약을 돌려준다', async () => {
    const summary = await runner().runOnce()

    assert.deepEqual(sync.calls, [1, 2, 3, 4])
    assert.deepEqual(summary, { total: 4, applied: 2, failed: 2, skipped: 0 })
  })

  it('대상 목록 읽기가 실패해도 다음 주기는 예약된다', async () => {
    runner(async () => {
      throw new Error('db down')
    }).start()

    await fake.fire()

    assert.equal(fake.pending().length, 1)
  })

  it('실행 중에 runOnce를 또 부르면 겹쳐 돌지 않고 건너뛴다', async () => {
    let listCalls = 0
    const r = runner(async () => {
      listCalls += 1
      return [1, 4]
    })

    const [first, second] = await Promise.all([r.runOnce(), r.runOnce()])

    assert.deepEqual(first, { total: 2, applied: 2, failed: 0, skipped: 0 })
    assert.deepEqual(second, { skipped: true })
    assert.equal(listCalls, 1)
  })

  it('stop(): 예약을 취소하고 더 예약하지 않는다', async () => {
    const r = runner()
    r.start()
    assert.equal(fake.pending().length, 1, '대조: start 뒤에는 예약이 있다')

    r.stop()

    assert.equal(fake.pending().length, 0)
  })

  it('requestSync: 그 사용자만 백그라운드로 동기화, 예외는 삼키고 whenIdle은 끝난다', async () => {
    const r = runner()

    r.requestSync(3)
    r.requestSync(4)
    await r.whenIdle()

    assert.deepEqual(sync.calls, [3, 4])
  })

  it('requestSync: 같은 사용자가 이미 돌고 있어 건너뛰면, 끝난 뒤 한 번 더 돌린다 (토큰 교체 직후 첫 동기화가 빠지지 않게)', async () => {
    const results = [{ outcome: 'skipped', reason: 'already_running' }, { outcome: 'applied' }]
    const busy = {
      calls: 0,
      async syncUser() {
        this.calls += 1
        return results.shift()
      },
    }
    const r = createSyncRunner({ lmsSync: busy, listTargets: async () => [], intervalMs: INTERVAL_MS, logger: silentLogger, timers: fake.timers })

    r.requestSync(1)
    await r.whenIdle()

    assert.equal(busy.calls, 2)
  })
})
