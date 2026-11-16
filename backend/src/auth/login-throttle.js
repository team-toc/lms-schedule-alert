import { maskEmail } from '../email/email-input.js'

// 이메일 로그인 실패 횟수 제한 (ADR 0007). 프로세스 메모리 Map, 시계는 주입받는다.
// 키: (정규화된 이메일, IP). lockMs는 "실패를 세는 기간"이자 "잠금 시간"이다.
const MS_PER_SECOND = 1000
// 실패 기록 표의 최대 항목 수 (메모리 상한). 넘으면 잠기지 않은 가장 오래된 항목부터 버린다.
export const LOGIN_THROTTLE_MAX_ENTRIES = 10000
const IPV4_TAIL_PATTERN = /^(.*[:.])?\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const IPV6_KEPT_GROUPS = 4
const MASK = '***'

// 로그용 IP 마스킹: IPv4(· IPv4-mapped IPv6)는 마지막 옥텟, IPv6는 앞 4블록만 남긴다
function maskIp(ip) {
  if (IPV4_TAIL_PATTERN.test(ip)) {
    return ip.replace(/\.\d{1,3}$/, `.${MASK}`)
  }
  if (ip.includes(':')) {
    return `${ip.split(':').slice(0, IPV6_KEPT_GROUPS).join(':')}:${MASK}`
  }
  return MASK
}

const keyOf = ({ email, ip }) => `${email}\n${ip}`
const isLocked = (entry, at) => entry.lockedUntil !== null && at < entry.lockedUntil
// 잠금이 있으면 잠금이 끝났는지, 없으면 세는 기간이 끝났는지
const isExpired = (entry, at, lockMs) => (entry.lockedUntil !== null ? at >= entry.lockedUntil : at >= entry.windowStart + lockMs)

function sweepExpired(entries, at, lockMs) {
  for (const [key, entry] of entries) {
    if (isExpired(entry, at, lockMs)) {
      entries.delete(key)
    }
  }
}

// 잠기지 않은 항목 중 가장 오래된 것(Map 삽입 순서)을 버린다. 잠긴 항목은 버리지 않는다(잠금 우회 방지).
function evictOldestUnlocked(entries, at) {
  for (const [key, entry] of entries) {
    if (!isLocked(entry, at)) {
      entries.delete(key)
      return true
    }
  }
  return false
}

// 새 키를 넣을 자리를 만든다. 모두 잠겨 자리가 없으면 false: 전체를 429로 막지 않고 이 키만 기록하지 않는다(경고 로그).
function makeRoom({ entries, maxEntries, logger }, attempt, at) {
  if (entries.size < maxEntries || evictOldestUnlocked(entries, at)) {
    return true
  }
  logger.warn(
    { event: 'login_throttle_full', email: maskEmail(attempt.email), ip: maskIp(attempt.ip), maxEntries },
    'login throttle table is full of locked entries, failure not recorded',
  )
  return false
}

export function createLoginThrottle({ maxFailures, lockMs, maxEntries, now, logger }) {
  const entries = new Map()
  const roomDeps = { entries, maxEntries, logger }

  function check(attempt) {
    const at = now()
    const entry = entries.get(keyOf(attempt))
    if (!entry || !isLocked(entry, at)) {
      return { allowed: true }
    }
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - at) / MS_PER_SECOND) }
  }

  function recordFailure(attempt) {
    const at = now()
    sweepExpired(entries, at, lockMs)
    const key = keyOf(attempt)
    let entry = entries.get(key)
    if (!entry) {
      if (!makeRoom(roomDeps, attempt, at)) {
        return
      }
      entry = { windowStart: at, failures: 0, lockedUntil: null }
      entries.set(key, entry)
    }
    entry.failures += 1
    if (entry.failures >= maxFailures) {
      entry.lockedUntil = at + lockMs
    }
  }

  return {
    check,
    recordFailure,
    reset: (attempt) => entries.delete(keyOf(attempt)),
    size: () => entries.size,
  }
}
