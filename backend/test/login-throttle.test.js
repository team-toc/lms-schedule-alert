import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createLoginThrottle } from '../src/auth/login-throttle.js'
import { createFakeClock, MINUTE_MS } from './helpers/email-flow.js'

const MAX_FAILURES = 5
const LOCK_MS = 15 * MINUTE_MS
const KEY = 'user@example.com|203.0.113.1'

function setup({ maxEntries = 100 } = {}) {
  const clock = createFakeClock()
  const throttle = createLoginThrottle({ maxFailures: MAX_FAILURES, lockMs: LOCK_MS, maxEntries, now: clock.now })
  return { clock, throttle }
}

function failTimes(throttle, key, times) {
  for (let i = 0; i < times; i += 1) {
    throttle.recordFailure(key)
  }
}

describe('로그인 실패 횟수 제한 (메모리, 주입한 시계)', () => {
  it('4번 실패까지는 허용, 5번째 실패부터 잠김', () => {
    const { throttle } = setup()
    failTimes(throttle, KEY, MAX_FAILURES - 1)
    assert.deepEqual(throttle.check(KEY), { allowed: true })

    throttle.recordFailure(KEY)

    assert.deepEqual(throttle.check(KEY), { allowed: false, retryAfterSeconds: 15 * 60 })
  })

  it('Retry-After는 남은 잠금 시간(초, 올림)이다', () => {
    const { clock, throttle } = setup()
    failTimes(throttle, KEY, MAX_FAILURES)

    clock.advance(10 * MINUTE_MS + 500)

    assert.deepEqual(throttle.check(KEY), { allowed: false, retryAfterSeconds: 5 * 60 })
  })

  it('잠금 시간이 정확히 지나면 다시 허용되고, 횟수도 처음부터 센다', () => {
    const { clock, throttle } = setup()
    failTimes(throttle, KEY, MAX_FAILURES)
    clock.advance(LOCK_MS - 1)
    assert.equal(throttle.check(KEY).allowed, false)

    clock.advance(1)

    assert.deepEqual(throttle.check(KEY), { allowed: true })
    throttle.recordFailure(KEY)
    assert.deepEqual(throttle.check(KEY), { allowed: true }, '이전 실패 횟수가 남아 있으면 안 됨')
  })

  it('15분 창 밖의 실패는 세지 않는다 (4번 실패 → 15분 뒤 1번 실패 → 허용)', () => {
    const { clock, throttle } = setup()
    failTimes(throttle, KEY, MAX_FAILURES - 1)

    clock.advance(LOCK_MS)
    throttle.recordFailure(KEY)

    assert.deepEqual(throttle.check(KEY), { allowed: true })
  })

  it('reset(로그인 성공)하면 실패 횟수가 지워진다', () => {
    const { throttle } = setup()
    failTimes(throttle, KEY, MAX_FAILURES - 1)

    throttle.reset(KEY)
    failTimes(throttle, KEY, MAX_FAILURES - 1)

    assert.deepEqual(throttle.check(KEY), { allowed: true })
  })

  it('키가 다르면 서로 영향이 없다', () => {
    const { throttle } = setup()
    failTimes(throttle, KEY, MAX_FAILURES)

    assert.deepEqual(throttle.check('user@example.com|198.51.100.7'), { allowed: true })
    assert.deepEqual(throttle.check('other@example.com|203.0.113.1'), { allowed: true })
  })

  it('만료 항목 정리: 창 · 잠금이 끝난 항목은 다음 기록 때 지워진다', () => {
    const { clock, throttle } = setup()
    throttle.recordFailure('a|1')
    failTimes(throttle, 'b|1', MAX_FAILURES)
    assert.equal(throttle.size(), 2)

    clock.advance(LOCK_MS)
    throttle.recordFailure('c|1')

    assert.equal(throttle.size(), 1)
  })

  it('최대 개수: 넘으면 가장 오래된 항목부터 버린다', () => {
    const { throttle } = setup({ maxEntries: 3 })
    for (const key of ['a|1', 'b|1', 'c|1', 'd|1']) {
      throttle.recordFailure(key)
    }

    assert.equal(throttle.size(), 3)
  })

  it('최대 개수: 잠긴 항목은 다른 키를 쏟아부어도 버려지지 않는다 (잠금 우회 방지)', () => {
    const { throttle } = setup({ maxEntries: 3 })
    failTimes(throttle, KEY, MAX_FAILURES)

    for (let i = 0; i < 10; i += 1) {
      throttle.recordFailure(`flood${i}@example.com|203.0.113.1`)
    }

    assert.equal(throttle.check(KEY).allowed, false)
    assert.ok(throttle.size() <= 3)
  })
})
