import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { createSyncRunner } from '../src/lms/sync-runner.js'

const silentLogger = pino({ level: 'silent' })
const noTimers = { setTimeout: () => null, clearTimeout: () => {} }
const tick = () => new Promise((resolve) => setImmediate(resolve))

// 테스트가 release()할 때까지 끝나지 않는 가짜 동기화. 동시에 몇 개가 돌고 있는지 기록한다
function createGatedSync() {
  const calls = []
  let active = 0
  let maxActive = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  return {
    calls,
    active: () => active,
    maxActive: () => maxActive,
    release: () => release(),
    async syncUser(userId) {
      calls.push(userId)
      active += 1
      maxActive = Math.max(maxActive, active)
      await gate
      active -= 1
      return { outcome: 'applied' }
    },
  }
}

function runnerWith(sync, { listTargets = async () => [], concurrency } = {}) {
  return createSyncRunner({ lmsSync: sync, listTargets, intervalMs: 60000, logger: silentLogger, timers: noTimers, concurrency })
}

async function settle(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await tick()
  }
}

describe('동기화 동시 실행 상한 (첫 · 주기 · 수동 전체 공통)', () => {
  it('요청이 상한(기본 2)보다 많이 와도 동시에 2개까지만 돌고, 나머지는 기다렸다가 모두 실행된다', async () => {
    const sync = createGatedSync()
    const runner = runnerWith(sync)

    for (const userId of [1, 2, 3, 4, 5]) {
      runner.requestSync(userId)
    }
    await settle()

    try {
      assert.equal(sync.active(), 2)
      assert.deepEqual(sync.calls, [1, 2], '들어온 순서대로')
    } finally {
      sync.release()
    }
    await runner.whenIdle()
    assert.deepEqual(sync.calls, [1, 2, 3, 4, 5])
    assert.equal(sync.maxActive(), 2)
  })

  it('상한은 설정값(concurrency)을 따른다', async () => {
    const sync = createGatedSync()
    const runner = runnerWith(sync, { concurrency: 3 })

    for (const userId of [1, 2, 3, 4, 5]) {
      runner.requestSync(userId)
    }
    await settle()
    sync.release()
    await runner.whenIdle()

    assert.equal(sync.maxActive(), 3)
  })

  it('주기 실행과 요청 실행이 같은 상한을 나눠 쓴다 (합쳐서 2개를 넘지 않음)', async () => {
    const sync = createGatedSync()
    const runner = runnerWith(sync, { listTargets: async () => [1, 2, 3] })

    const run = runner.runOnce()
    for (const userId of [10, 11, 12]) {
      runner.requestSync(userId)
    }
    await settle()

    try {
      assert.equal(sync.active(), 2)
    } finally {
      sync.release()
    }
    await run
    await runner.whenIdle()
    assert.equal(sync.maxActive(), 2)
    assert.deepEqual([...sync.calls].sort((x, y) => x - y), [1, 2, 3, 10, 11, 12])
  })

  it('stop() 뒤의 요청은 실행하지 않고 shutting_down으로 건너뛴다', async () => {
    const sync = createGatedSync()
    const runner = runnerWith(sync)
    runner.stop()

    assert.deepEqual(await runner.requestSync(1), { outcome: 'skipped', reason: 'shutting_down' })
    assert.equal(sync.calls.length, 0)
  })

  it('주기 실행 도중 stop()하면 지금 사용자까지만 하고 멈춘다', async () => {
    const sync = createGatedSync()
    const runner = runnerWith(sync, { listTargets: async () => [1, 2, 3] })
    const run = runner.runOnce()
    await settle()

    runner.stop()
    sync.release()

    assert.deepEqual(await run, { total: 3, applied: 1, failed: 0, skipped: 0 })
    assert.deepEqual(sync.calls, [1])
  })

  it('재시도는 같은 사용자의 진행 중 동기화(whenUserIdle)가 끝난 뒤에 한다', async () => {
    const order = []
    let releaseRunning
    const running = new Promise((resolve) => {
      releaseRunning = resolve
    })
    const results = [{ outcome: 'skipped', reason: 'already_running' }, { outcome: 'applied' }]
    const sync = {
      async syncUser() {
        order.push('sync')
        return results.shift()
      },
      async whenUserIdle() {
        await running
        order.push('previous finished')
      },
    }
    const runner = runnerWith(sync)

    const result = runner.requestSync(1)
    await settle()
    assert.deepEqual(order, ['sync'])
    releaseRunning()

    assert.deepEqual(await result, { outcome: 'applied' })
    assert.deepEqual(order, ['sync', 'previous finished', 'sync'])
  })
})
