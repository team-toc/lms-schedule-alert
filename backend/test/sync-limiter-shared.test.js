import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter } from '../src/sync/limiter.js'
import { createSyncRunner } from '../src/lms/sync-runner.js'

const silent = { info() {}, warn() {}, error() {} }

// 동기화 하나를 붙잡아 두는 가짜. running이 동시에 몇 개였는지 센다
function createProbe() {
  const probe = { running: 0, max: 0, waiting: [] }
  probe.sync = {
    syncUser() {
      probe.running += 1
      probe.max = Math.max(probe.max, probe.running)
      return new Promise((resolve) => {
        probe.waiting.push(() => {
          probe.running -= 1
          resolve({ outcome: 'applied' })
        })
      })
    },
  }
  probe.releaseAll = () => probe.waiting.splice(0).forEach((done) => done())
  return probe
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

// 동시 실행 상한 공유 (ADR 0010 공통화): Canvas · iCloud 두 실행기가 제한기 하나를 함께 쓰면 합계가 상한을 넘지 않는다
describe('동기화 제한기 공유 (src/sync/limiter.js)', () => {
  it('createLimiter(2): 동시에 2개까지만 실행하고 나머지는 들어온 순서대로', async () => {
    const limit = createLimiter(2)
    const order = []
    const gates = []
    const tasks = [1, 2, 3].map((n) =>
      limit(() => {
        order.push(n)
        return new Promise((resolve) => gates.push(resolve))
      }),
    )
    await tick()
    assert.deepEqual(order, [1, 2])
    gates.shift()()
    await tick()
    await tick()
    assert.deepEqual(order, [1, 2, 3])
    gates.forEach((resolve) => resolve())
    await Promise.all(tasks)
  })

  it('두 실행기에 같은 제한기(1)를 넘기면 둘을 합쳐 동시에 1개만 돈다', async () => {
    const probe = createProbe()
    const limit = createLimiter(1)
    const canvas = createSyncRunner({ lmsSync: probe.sync, listTargets: async () => [], intervalMs: 1000, logger: silent, limit })
    const icloud = createSyncRunner({ lmsSync: probe.sync, listTargets: async () => [], intervalMs: 1000, logger: silent, limit })

    canvas.requestSync(1)
    icloud.requestSync(2)
    canvas.requestSync(3)
    for (let i = 0; i < 3; i += 1) {
      await tick()
      assert.equal(probe.running, 1)
      probe.releaseAll()
      await tick()
    }
    await Promise.all([canvas.whenIdle(), icloud.whenIdle()])

    assert.equal(probe.max, 1, '합계 동시 실행 1')
  })

  it('제한기를 넘기지 않으면 지금처럼 concurrency로 실행기마다 따로 만든다 (기존 동작 그대로)', async () => {
    const probe = createProbe()
    const runner = createSyncRunner({ lmsSync: probe.sync, listTargets: async () => [], intervalMs: 1000, logger: silent, concurrency: 2 })

    runner.requestSync(1)
    runner.requestSync(2)
    runner.requestSync(3)
    await tick()
    assert.equal(probe.running, 2)
    while (probe.running > 0 || probe.waiting.length > 0) {
      probe.releaseAll()
      await tick()
    }
    await runner.whenIdle()
    assert.equal(probe.max, 2)
  })
})
