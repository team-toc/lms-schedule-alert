import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { createLoginThrottle } from '../src/auth/login-throttle.js'
import { createFakeClock, MINUTE_MS } from './helpers/email-flow.js'

const MAX_FAILURES = 5
const LOCK_MS = 15 * MINUTE_MS
const KEY = { email: 'user@example.com', ip: '203.0.113.1' }

function createCapturingLogger() {
  const entries = []
  return { entries, logger: pino({ level: 'trace' }, { write: (line) => entries.push(JSON.parse(line)) }) }
}

function setup({ maxEntries = 100, logger = pino({ level: 'silent' }) } = {}) {
  const clock = createFakeClock()
  const throttle = createLoginThrottle({ maxFailures: MAX_FAILURES, lockMs: LOCK_MS, maxEntries, now: clock.now, logger })
  return { clock, throttle }
}

function failTimes(throttle, key, times) {
  for (let i = 0; i < times; i += 1) {
    throttle.recordFailure(key)
  }
}

const keyOf = (name) => ({ email: `${name}@example.com`, ip: '203.0.113.1' })

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

  it('실패를 세는 기간도 같은 값(LOCK_MS): 4번 실패 → 그 시간 뒤 1번 실패 → 허용', () => {
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

  it('이메일 · IP 중 하나만 달라도 다른 카운터', () => {
    const { throttle } = setup()
    failTimes(throttle, KEY, MAX_FAILURES)

    assert.deepEqual(throttle.check({ ...KEY, ip: '198.51.100.7' }), { allowed: true })
    assert.deepEqual(throttle.check({ ...KEY, email: 'other@example.com' }), { allowed: true })
  })

  it('만료 항목 정리: 기간 · 잠금이 끝난 항목은 다음 기록 때 지워진다', () => {
    const { clock, throttle } = setup()
    throttle.recordFailure(keyOf('a'))
    failTimes(throttle, keyOf('b'), MAX_FAILURES)
    assert.equal(throttle.size(), 2)

    clock.advance(LOCK_MS)
    throttle.recordFailure(keyOf('c'))

    assert.equal(throttle.size(), 1)
  })

  it('최대 개수: 넘으면 잠기지 않은 항목 중 가장 오래된 것부터 버린다', () => {
    const { throttle } = setup({ maxEntries: 3 })
    for (const name of ['a', 'b', 'c', 'd']) {
      throttle.recordFailure(keyOf(name))
    }

    assert.equal(throttle.size(), 3)
  })

  it('최대 개수: 잠긴 항목은 다른 키를 쏟아부어도 버려지지 않는다 (잠금 우회 방지)', () => {
    const { throttle } = setup({ maxEntries: 3 })
    failTimes(throttle, KEY, MAX_FAILURES)

    for (let i = 0; i < 10; i += 1) {
      throttle.recordFailure(keyOf(`flood${i}`))
    }

    assert.equal(throttle.check(KEY).allowed, false)
    assert.ok(throttle.size() <= 3)
  })

  describe('표가 꽉 찼고 모든 항목이 잠긴 상태', () => {
    function fillWithLockedEntries(throttle) {
      failTimes(throttle, keyOf('locked1'), MAX_FAILURES)
      failTimes(throttle, keyOf('locked2'), MAX_FAILURES)
    }

    it('새 키는 기록하지 않고 통과시킨다 (전체를 429로 막지 않음), 기존 잠금은 유지', () => {
      const { throttle } = setup({ maxEntries: 2 })
      fillWithLockedEntries(throttle)
      const newcomer = { email: 'newcomer@example.com', ip: '198.51.100.7' }

      failTimes(throttle, newcomer, MAX_FAILURES + 3)

      assert.deepEqual(throttle.check(newcomer), { allowed: true }, '새 키는 기록되지 않으므로 잠기지도 않음')
      assert.equal(throttle.size(), 2)
      assert.equal(throttle.check(keyOf('locked1')).allowed, false)
      assert.equal(throttle.check(keyOf('locked2')).allowed, false)
    })

    it('기록을 건너뛸 때 경고 로그를 남기되 이메일 · IP는 마스킹 값만', () => {
      const capture = createCapturingLogger()
      const { throttle } = setup({ maxEntries: 2, logger: capture.logger })
      fillWithLockedEntries(throttle)

      throttle.recordFailure({ email: 'newcomer@example.com', ip: '198.51.100.7' })

      const warning = capture.entries.find((e) => e.event === 'login_throttle_full')
      assert.ok(warning, '경고 로그가 있어야 함')
      assert.equal(warning.level, 40)
      assert.equal(warning.email, 'n***@example.com')
      assert.equal(warning.ip, '198.51.100.***')
      assert.equal(warning.maxEntries, 2)
      const text = JSON.stringify(capture.entries)
      assert.ok(!text.includes('newcomer@example.com') && !text.includes('198.51.100.7'), '원문이 로그에 있음')
    })

    it('IPv6 주소도 마스킹한다 (앞 4블록만)', () => {
      const capture = createCapturingLogger()
      const { throttle } = setup({ maxEntries: 2, logger: capture.logger })
      fillWithLockedEntries(throttle)

      throttle.recordFailure({ email: 'newcomer@example.com', ip: '2001:db8:85a3:8d3:1319:8a2e:370:7348' })

      const warning = capture.entries.find((e) => e.event === 'login_throttle_full')
      assert.equal(warning.ip, '2001:db8:85a3:8d3:***')
    })

    it('잠긴 항목이 풀리면(만료) 다시 새 키를 기록한다', () => {
      const { clock, throttle } = setup({ maxEntries: 2 })
      fillWithLockedEntries(throttle)
      clock.advance(LOCK_MS)
      const newcomer = { email: 'newcomer@example.com', ip: '198.51.100.7' }

      failTimes(throttle, newcomer, MAX_FAILURES)

      assert.equal(throttle.check(newcomer).allowed, false)
    })
  })
})
