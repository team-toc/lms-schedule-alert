import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { withNamedLock } from '../src/db/named-lock.js'
import { createLmsTokenRepository } from '../src/lms/lms-token-repository.js'

// 이름 있는 잠금 (ADR 0010 공통화): MariaDB GET_LOCK(대기 0초). Canvas 사용자 잠금과 같은 이름 규칙(DB 이름 + ':' + 이름)
function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('이름 있는 잠금 (src/db/named-lock.js)', () => {
  let ctx

  before(async () => {
    ctx = await openTestContext()
  })
  after(async () => {
    await ctx.close()
  })

  // work 안에서 붙잡고 있다가 release()로 끝낸다
  function hold(name) {
    const inside = deferred()
    const release = deferred()
    const done = withNamedLock(ctx.pool, name, async () => {
      inside.resolve()
      await release.promise
      return 'first'
    })
    return { inside: inside.promise, release: release.resolve, done }
  }

  it('잡으면 work 결과를 돌려주고, 같은 이름을 동시에 잡으면 acquired: false (기다리지 않음)', async () => {
    const first = hold('calendar_sync:1')
    try {
      await first.inside
      assert.deepEqual(await withNamedLock(ctx.pool, 'calendar_sync:1', async () => 'second'), { acquired: false })
    } finally {
      first.release()
    }
    assert.deepEqual(await first.done, { acquired: true, result: 'first' })
  })

  it('이름이 다르면 동시에 잡힌다', async () => {
    const first = hold('calendar_sync:2')
    try {
      await first.inside
      assert.deepEqual(await withNamedLock(ctx.pool, 'calendar_sync:3', async () => 'other'), { acquired: true, result: 'other' })
    } finally {
      first.release()
    }
    await first.done
  })

  it('work가 던져도 잠금을 풀고 에러를 그대로 던진다 (다음에 다시 잡힘)', async () => {
    await assert.rejects(withNamedLock(ctx.pool, 'calendar_sync:4', async () => {
      throw new Error('boom')
    }), /boom/)

    assert.deepEqual(await withNamedLock(ctx.pool, 'calendar_sync:4', async () => 'again'), { acquired: true, result: 'again' })
  })

  it('Canvas 사용자 잠금과 같은 이름 규칙: lms_sync:<id>를 잡고 있으면 Canvas 동기화 잠금은 못 잡는다 (refactor 뒤에도 같은 잠금)', async () => {
    const repository = createLmsTokenRepository(ctx.pool, { logger: ctx.silentLogger })
    const first = hold('lms_sync:77')
    try {
      await first.inside
      assert.deepEqual(await repository.withSyncLock(77, async () => 'canvas'), { acquired: false })
    } finally {
      first.release()
    }
    await first.done
    assert.deepEqual(await repository.withSyncLock(77, async () => 'canvas'), { acquired: true, result: 'canvas' })
  })
})
