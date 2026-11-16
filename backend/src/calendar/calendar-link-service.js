// iCloud 연결 등록 · 목록 · 삭제 · 수동 동기화 (ADR 0010).
// 등록: 형식 검사 → (싸게) 중복 · 개수 확인 → 실제로 받아 파싱되는지 → 암호화 저장(개수 상한은 잠금 안에서 다시) → 첫 동기화(백그라운드).
// 실패하면 아무것도 저장하지 않는다. 링크 원문은 응답 · 로그 · 에러에 넣지 않는다.
// 결과: { link } | { links } | { deleted: true } | { status } | { failure: { status, error, field?, retryAfterSeconds? } }
import { normalizeIcloudUrl } from './icloud-url.js'
import { IcloudFetchError, ICLOUD_ERRORS } from './icloud-client.js'
import { parseIcsEvents, IcsParseError } from './ics-events.js'
import { syncWindow } from './calendar-sync.js'

export const MAX_CALENDAR_LINKS_PER_USER = 5
const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1000
const MS_PER_SECOND = 1000

// 받아 보기 · 파싱 오류 코드 → HTTP 상태 (표에 없으면 400)
const FETCH_STATUS = new Map([
  [ICLOUD_ERRORS.unavailable, 502],
  [ICLOUD_ERRORS.rateLimited, 503],
  [ICLOUD_ERRORS.timeout, 504],
])
const ADMISSION_FAILURES = {
  duplicate: { status: 409, error: 'calendar_link_already_registered' },
  limit: { status: 409, error: 'calendar_link_limit_reached' },
}
const NOT_FOUND = { failure: { status: 404, error: 'calendar_link_not_found' } }

const urlFailure = (error, status = 400) => ({ failure: { status, error, field: 'url' } })

const publicLink = (link) => ({
  id: link.id,
  provider: link.provider,
  syncStatus: link.syncStatus,
  lastSyncedAt: link.lastSyncedAt?.toISOString() ?? null,
  lastErrorCode: link.lastErrorCode,
  createdAt: link.createdAt.toISOString(),
})

// 실제로 받아 파싱되는지 (등록 때 한 번). 결과: null | { failure }
async function verifyCalendar({ icloudClient, now }, url) {
  try {
    parseIcsEvents(await icloudClient.fetchCalendar(url), syncWindow(now()))
    return null
  } catch (err) {
    if (err instanceof IcloudFetchError || err instanceof IcsParseError) {
      return urlFailure(err.code, FETCH_STATUS.get(err.code) ?? 400)
    }
    throw err
  }
}

// 연결별 5분 쿨다운(프로세스 메모리). 실행은 그 사용자의 연결 전체 동기화(사용자 잠금 하나)
async function requestManualSync({ linkRepository, syncRunner, now, lastManualSync }, userId, id) {
  const link = id === null ? null : await linkRepository.findLink(userId, id)
  if (!link) return NOT_FOUND
  if (link.syncStatus === 'invalid') return { failure: { status: 409, error: 'calendar_link_invalid' } }
  const nowMs = now().getTime()
  const last = lastManualSync.get(link.id)
  if (last !== undefined && nowMs - last < MANUAL_SYNC_COOLDOWN_MS) {
    return { failure: { status: 429, error: 'sync_too_frequent', retryAfterSeconds: Math.ceil((MANUAL_SYNC_COOLDOWN_MS - (nowMs - last)) / MS_PER_SECOND) } }
  }
  lastManualSync.set(link.id, nowMs)
  syncRunner.requestSync(userId)
  return { status: link.syncStatus }
}

export function createCalendarLinkService({ linkRepository, linkCipher, hashUrl, icloudClient, syncRunner, now }) {
  const lastManualSync = new Map()

  async function registerIcloud(userId, input) {
    const { url, error } = normalizeIcloudUrl(input)
    if (error) return urlFailure(error)
    const urlHash = hashUrl(url)
    const early = await linkRepository.checkAdmission(userId, urlHash, MAX_CALENDAR_LINKS_PER_USER)
    if (early) return { failure: ADMISSION_FAILURES[early] }
    const unusable = await verifyCalendar({ icloudClient, now }, url)
    if (unusable) return unusable
    const urlEnc = linkCipher.encrypt(url, { userId })
    const saved = await linkRepository.insertLink({ userId, provider: 'icloud', urlEnc, urlHash, max: MAX_CALENDAR_LINKS_PER_USER })
    if (saved.error) return { failure: ADMISSION_FAILURES[saved.error] }
    syncRunner.requestSync(userId)
    return { link: { id: saved.id, provider: 'icloud', syncStatus: 'syncing' } }
  }

  async function list(userId) {
    return { links: (await linkRepository.listLinks(userId)).map(publicLink) }
  }

  async function remove(userId, id) {
    return id !== null && (await linkRepository.deleteLink(userId, id)) ? { deleted: true } : NOT_FOUND
  }

  return { registerIcloud, list, remove, requestSync: (userId, id) => requestManualSync({ linkRepository, syncRunner, now, lastManualSync }, userId, id) }
}
