// 외부 캘린더(iCloud) 동기화 (ADR 0010). Canvas 동기화(ADR 0008)와 같은 틀:
// 1) 사용자 잠금(calendar_sync:<id>) → 2) 연결마다 복호화 → 받기(icloud-client) → 파싱 · 창 안 회차(ics-events)
// → 3) 전부 성공했을 때만 그 연결을 한 트랜잭션으로 반영. 연결 하나가 실패해도 다른 연결은 계속한다.
// 링크 · 제목은 로그에 남기지 않는다(연결 id · 개수 · 오류 코드만).
import { withNamedLock } from '../db/named-lock.js'
import { TokenDecryptError } from '../lms/token-cipher.js'
import { IcloudFetchError, ICLOUD_ERRORS } from './icloud-client.js'
import { parseIcsEvents, IcsParseError } from './ics-events.js'

const DAY_MS = 24 * 60 * 60 * 1000
export const SYNC_WINDOW = { pastDays: 30, futureDays: 180 }
export const LINK_UNREADABLE = 'calendar_link_unreadable'
const INTERNAL_ERROR = 'internal_error'
// 링크가 무효(삭제 · 공개 해제)거나 지금 키로 풀 수 없으면 다시 등록해야 한다 → 주기 실행에서 뺀다
const INVALID_CODES = new Set([ICLOUD_ERRORS.linkInvalid, LINK_UNREADABLE])

export function syncWindow(now) {
  return { windowStart: new Date(now.getTime() - SYNC_WINDOW.pastDays * DAY_MS), windowEnd: new Date(now.getTime() + SYNC_WINDOW.futureDays * DAY_MS) }
}

const errorCodeOf = (err) => (err instanceof IcloudFetchError || err instanceof IcsParseError ? err.code : null)

// 사용자별 진행 중 동기화 (실행기가 "이미 실행 중"으로 건너뛴 뒤 끝나기를 기다릴 때)
function createRunningTracker() {
  const running = new Map()
  return {
    track(userId, promise) {
      const set = running.get(userId) ?? new Set()
      set.add(promise)
      running.set(userId, set)
      const done = () => {
        set.delete(promise)
        if (set.size === 0) running.delete(userId)
      }
      promise.then(done, done)
      return promise
    },
    whenUserIdle: (userId) => Promise.allSettled([...(running.get(userId) ?? [])]),
  }
}

async function recordFailed({ linkRepository, logger }, { userId, link }, errorCode) {
  const status = INVALID_CODES.has(errorCode) ? 'invalid' : 'failing'
  await linkRepository.recordFailure({ linkId: link.id, urlEnc: link.urlEnc, status, errorCode })
  logger.warn({ event: 'calendar_sync_failed', userId, linkId: link.id, errorCode, status }, 'calendar sync failed')
  return 'failed'
}

// 결과: 'applied' | 'failed' | 'discarded'(그 사이 연결이 지워지거나 바뀜)
async function syncLink(deps, userId, link) {
  const { linkCipher, icloudClient, syncRepository, now, logger } = deps
  let url
  try {
    url = linkCipher.decrypt(link.urlEnc, { userId })
  } catch (err) {
    if (err instanceof TokenDecryptError) return recordFailed(deps, { userId, link }, LINK_UNREADABLE)
    throw err
  }
  const at = now()
  let parsed
  try {
    parsed = parseIcsEvents(await icloudClient.fetchCalendar(url), syncWindow(at))
  } catch (err) {
    const code = errorCodeOf(err)
    if (!code) throw err
    return recordFailed(deps, { userId, link }, code)
  }
  const applied = await syncRepository.applyLinkEvents({ userId, linkId: link.id, urlEnc: link.urlEnc, events: parsed.events, now: at })
  if (!applied) {
    logger.info({ event: 'calendar_sync_discarded', userId, linkId: link.id }, 'calendar link changed during sync, result discarded')
    return 'discarded'
  }
  logger.info({ event: 'calendar_sync_applied', userId, linkId: link.id, events: applied.events, removed: applied.removed, skipped: parsed.skipped }, 'calendar sync applied')
  return 'applied'
}

// 예상 밖 에러(DB 등): 이름 · 코드만 로그, 그 연결은 failing · internal_error. 기록까지 실패해도 던지지 않는다
async function syncLinkSafely(deps, userId, link) {
  const { linkRepository, logger } = deps
  try {
    return await syncLink(deps, userId, link)
  } catch (err) {
    logger.error({ event: 'calendar_sync_crashed', userId, linkId: link.id, err: { name: err?.name, code: err?.code } }, 'calendar sync crashed')
    await linkRepository.recordFailure({ linkId: link.id, urlEnc: link.urlEnc, status: 'failing', errorCode: INTERNAL_ERROR }).catch(() => {})
    return 'failed'
  }
}

export function createCalendarSync(deps) {
  const { pool, linkRepository } = deps
  const tracker = createRunningTracker()

  async function runSync(userId) {
    const links = await linkRepository.linksToSync(userId)
    if (links.length === 0) {
      return { outcome: 'skipped', reason: 'not_connected' }
    }
    const results = []
    for (const link of links) {
      results.push(await syncLinkSafely(deps, userId, link))
    }
    return { outcome: results.every((r) => r === 'failed') ? 'failed' : 'applied', links: results.length }
  }

  // 결과: { outcome: 'applied' | 'failed', links } | { outcome: 'skipped', reason }
  async function lockedSync(userId) {
    const { acquired, result } = await withNamedLock(pool, `calendar_sync:${userId}`, () => runSync(userId))
    return acquired ? result : { outcome: 'skipped', reason: 'already_running' }
  }

  return {
    syncUser: (userId) => tracker.track(userId, lockedSync(userId)),
    whenUserIdle: tracker.whenUserIdle,
  }
}
