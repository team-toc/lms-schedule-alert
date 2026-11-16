import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { createShutdown } from '../src/shutdown.js'
import { createSyncRunner } from '../src/lms/sync-runner.js'

const GRACE_MS = 10000

function createCapturingLogger() {
  const entries = []
  return { entries, logger: pino({ level: 'trace' }, { write: (line) => entries.push(JSON.parse(line)) }) }
}

// 종료 순서를 기록하는 가짜 서버 · 실행기 · 풀 · exit, 예약만 기록하는 타이머
function createFakes({ idle = Promise.resolve() } = {}) {
  const order = []
  const scheduled = []
  return {
    order,
    scheduled,
    server: { close: () => order.push('server.close') },
    syncRunner: {
      stop: () => order.push('runner.stop'),
      whenIdle: () => idle.then(() => order.push('runner.idle')),
    },
    pool: { end: async () => order.push('pool.end') },
    exit: (code) => order.push(`exit(${code})`),
    timers: {
      setTimeout(fn, ms) {
        const timer = { fn, ms }
        scheduled.push(timer)
        return timer
      },
      clearTimeout(timer) {
        if (timer) {
          timer.cleared = true
        }
      },
    },
  }
}

describe('서버 종료 (SIGTERM · SIGINT)', () => {
  it('실행기 정지 → 새 연결 받지 않음 → 진행 중 동기화가 끝나면 → 풀 정리 → exit(0)', async () => {
    const fakes = createFakes()
    const { logger, entries } = createCapturingLogger()

    await createShutdown({ ...fakes, logger, graceMs: GRACE_MS })('SIGTERM')

    assert.deepEqual(fakes.order, ['runner.stop', 'server.close', 'runner.idle', 'pool.end', 'exit(0)'])
    assert.equal(fakes.scheduled[0].ms, GRACE_MS)
    assert.equal(fakes.scheduled[0].cleared, true, '끝났으면 유예 타이머를 지운다')
    assert.deepEqual(entries.map((e) => e.event), ['shutdown_started', 'shutdown_finished'])
    assert.equal(entries[0].signal, 'SIGTERM')
  })

  it('유예 시간(10초) 안에 동기화가 끝나지 않으면 기다리지 않고 종료한다 (반영 없이 중단, 경고 로그)', async () => {
    const fakes = createFakes({ idle: new Promise(() => {}) })
    const { logger, entries } = createCapturingLogger()
    const done = createShutdown({ ...fakes, logger, graceMs: GRACE_MS })('SIGTERM')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(fakes.order, ['runner.stop', 'server.close'], '유예 시간 동안은 기다린다')

    fakes.scheduled[0].fn()
    await done

    assert.deepEqual(fakes.order, ['runner.stop', 'server.close', 'exit(0)'], '풀을 정리하지 않고(연결이 끊기며 트랜잭션 롤백) 끝낸다')
    assert.ok(entries.some((e) => e.event === 'shutdown_syncs_abandoned' && e.level === 40))
  })

  it('신호가 두 번 와도 한 번만 처리한다', async () => {
    const fakes = createFakes()
    const shutdown = createShutdown({ ...fakes, logger: pino({ level: 'silent' }) })

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')])

    assert.equal(fakes.order.filter((step) => step === 'runner.stop').length, 1)
    assert.equal(fakes.order.filter((step) => step === 'exit(0)').length, 1)
  })

  it('실제 실행기와: 종료하면 다음 주기 예약이 취소되고, 진행 중 동기화가 끝난 뒤에 exit한다', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const calls = []
    const lmsSync = {
      async syncUser(userId) {
        calls.push(userId)
        await gate
        return { outcome: 'applied' }
      },
    }
    const fakes = createFakes()
    const runner = createSyncRunner({ lmsSync, listTargets: async () => [], intervalMs: 60000, logger: pino({ level: 'silent' }), timers: fakes.timers })
    runner.start()
    runner.requestSync(1)

    const done = createShutdown({ ...fakes, syncRunner: runner, logger: pino({ level: 'silent' }) })('SIGTERM')
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(fakes.scheduled[0].cleared, true, '주기 예약 취소')
    assert.deepEqual(await runner.requestSync(2), { outcome: 'skipped', reason: 'shutting_down' })
    assert.ok(!fakes.order.includes('exit(0)'), '진행 중 동기화를 기다린다')
    release()
    await done
    assert.deepEqual(calls, [1])
    assert.deepEqual(fakes.order.slice(-2), ['pool.end', 'exit(0)'])
  })
})
