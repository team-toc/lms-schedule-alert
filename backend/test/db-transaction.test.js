import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { runInTransaction } from '../src/db/transaction.js'

const silentLogger = pino({ level: 'silent' })

function createFakePool({ workError = null, rollbackError = null } = {}) {
  const calls = []
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    commit: async () => calls.push('commit'),
    rollback: async () => {
      calls.push('rollback')
      if (rollbackError) {
        throw rollbackError
      }
    },
    release: () => calls.push('release'),
    destroy: () => calls.push('destroy'),
  }
  const work = async () => {
    calls.push('work')
    if (workError) {
      throw workError
    }
    return 'result'
  }
  return { calls, work, pool: { getConnection: async () => connection } }
}

describe('공용 트랜잭션 실행기 (src/db/transaction.js)', () => {
  it('성공하면 commit 후 연결을 반납하고 결과를 돌려준다', async () => {
    const { pool, work, calls } = createFakePool()

    assert.equal(await runInTransaction({ pool, logger: silentLogger }, work), 'result')
    assert.deepEqual(calls, ['begin', 'work', 'commit', 'release'])
  })

  it('실패하면 롤백하고 원래 에러를 그대로 올린다 (중복 키도 다른 에러로 바꾸지 않음)', async () => {
    const duplicate = Object.assign(new Error('Duplicate entry'), { errno: 1062, code: 'ER_DUP_ENTRY' })
    const { pool, work, calls } = createFakePool({ workError: duplicate })

    await assert.rejects(runInTransaction({ pool, logger: silentLogger }, work), (err) => err === duplicate)
    assert.deepEqual(calls, ['begin', 'work', 'rollback', 'release'])
  })

  it('롤백도 실패하면 원래 에러를 올리고 연결은 반납하지 않고 버린다', async () => {
    const original = new Error('deadlock')
    const { pool, work, calls } = createFakePool({ workError: original, rollbackError: new Error('connection lost') })

    await assert.rejects(runInTransaction({ pool, logger: silentLogger }, work), (err) => err === original)
    assert.deepEqual(calls, ['begin', 'work', 'rollback', 'destroy'])
  })
})
