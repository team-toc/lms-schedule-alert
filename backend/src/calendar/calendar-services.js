// 일정 · 외부 캘린더 서비스 조립 (ADR 0010). createLmsServices가 Canvas와 같은 풀 · 시계 · 로거 · 동시 실행 제한기로 부른다.
// 링크 암호화는 Canvas 토큰과 같은 키, 용도(AAD)만 다르게. 중복 확인 해시 키는 같은 키에서 HKDF로 파생.
import { createTokenCipher, CIPHER_CONTEXTS } from '../lms/token-cipher.js'
import { createSyncRunner } from '../lms/sync-runner.js'
import { createIcloudClient } from './icloud-client.js'
import { createLinkUrlHasher } from './link-url-hash.js'
import { createCalendarLinkRepository } from './calendar-link-repository.js'
import { createScheduleSyncRepository } from './schedule-sync-repository.js'
import { createCalendarSync } from './calendar-sync.js'
import { createCalendarLinkService } from './calendar-link-service.js'

export function createCalendarServices({ pool, logger, lmsConfig, icloudFetchFn, now, limit }) {
  const linkRepository = createCalendarLinkRepository(pool, { logger })
  const linkCipher = createTokenCipher({ key: lmsConfig.tokenKey, context: CIPHER_CONTEXTS.icloudLink })
  const icloudClient = createIcloudClient({ fetchFn: icloudFetchFn })
  const calendarSync = createCalendarSync({
    pool,
    linkRepository,
    syncRepository: createScheduleSyncRepository(pool, { logger }),
    linkCipher,
    icloudClient,
    now,
    logger,
  })
  const calendarSyncRunner = createSyncRunner({ lmsSync: calendarSync, listTargets: linkRepository.listSyncTargets, intervalMs: lmsConfig.syncIntervalMs, logger, limit })
  const calendarLinkService = createCalendarLinkService({
    linkRepository,
    linkCipher,
    hashUrl: createLinkUrlHasher({ key: lmsConfig.tokenKey }),
    icloudClient,
    syncRunner: calendarSyncRunner,
    now,
  })
  return { calendarSync, calendarSyncRunner, calendarLinkService }
}
