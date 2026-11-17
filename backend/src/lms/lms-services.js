// Canvas 연동 서비스 조립 (ADR 0008). 서버 진입점과 테스트가 같은 함수로 만든다.
// 바깥 의존(DB 풀 · fetch · 시계 · 로거)은 주입받는다.
import { createCanvasClient } from '../canvas/canvas-client.js'
import { createTokenCipher } from './token-cipher.js'
import { createLmsTokenRepository } from './lms-token-repository.js'
import { createLmsSyncRepository } from './lms-sync-repository.js'
import { createLmsSync } from './lms-sync.js'
import { createSyncRunner } from './sync-runner.js'
import { createTokenService } from './token-service.js'
import { createManualSync } from './manual-sync.js'
import { createCalendarRepository } from '../calendar/calendar-repository.js'
import { createNotificationRepository } from '../notifications/notification-repository.js'
import { createScheduleRepository } from '../calendar/schedule-repository.js'
import { createScheduleService } from '../calendar/schedule-service.js'
import { createScheduleQueries } from '../calendar/schedule-queries.js'
import { createCalendarServices } from '../calendar/calendar-services.js'
import { createLimiter } from '../sync/limiter.js'
import { createRuleExtractor } from '../suggestions/rule-extractor.js'
import { createSuggestionStep } from '../suggestions/suggestion-step.js'
import { createSuggestionRepository } from '../suggestions/suggestion-repository.js'
import { createSuggestionService } from '../suggestions/suggestion-service.js'

const DEFAULT_SYNC_CONCURRENCY = 2

// icloudFetchFn: iCloud 공개 캘린더 요청용 fetch(테스트는 가짜). 동시 실행 상한은 Canvas · iCloud 실행기가 제한기 하나를 함께 쓴다(ADR 0010)
// 공지 일정 제안(ADR 0011): classPeriods는 교시 시간표(Map, 서버는 config/class-periods.json). Canvas 반영이 커밋된 뒤
// 같은 사용자 잠금 안에서 제안 단계를 돈다. suggestionExtractor · afterCanvasApplied는 바꿔 끼우기용(기본은 규칙 추출기 · 제안 단계)
export function createLmsServices(options) {
  const { pool, logger, lmsConfig, fetchFn = globalThis.fetch, icloudFetchFn = globalThis.fetch, now = () => new Date() } = options
  const extractor = options.suggestionExtractor ?? createRuleExtractor({ classPeriods: options.classPeriods ?? new Map() })
  const afterCanvasApplied = options.afterCanvasApplied ?? createSuggestionStep({ pool, logger, extractor })
  const limit = createLimiter(lmsConfig.syncConcurrency ?? DEFAULT_SYNC_CONCURRENCY)
  const canvasClient = createCanvasClient({ baseUrl: lmsConfig.canvasBaseUrl, fetchFn })
  const tokenCipher = createTokenCipher({ key: lmsConfig.tokenKey })
  const tokenRepository = createLmsTokenRepository(pool, { logger })
  const syncRepository = createLmsSyncRepository(pool, { logger })
  const lmsSync = createLmsSync({
    canvasClient,
    tokenCipher,
    tokenRepository,
    syncRepository,
    baseUrl: lmsConfig.canvasBaseUrl,
    now,
    logger,
    afterApplied: afterCanvasApplied,
  })
  const syncRunner = createSyncRunner({
    lmsSync,
    listTargets: tokenRepository.listSyncTargets,
    intervalMs: lmsConfig.syncIntervalMs,
    limit,
    logger,
  })
  const tokenService = createTokenService({ canvasClient, tokenCipher, tokenRepository, syncRunner, now, logger })
  const manualSync = createManualSync({ tokenRepository, syncRunner, now })
  return {
    lmsSync,
    syncRunner,
    tokenService,
    manualSync,
    calendarRepository: createCalendarRepository(pool),
    scheduleQueries: createScheduleQueries(pool),
    notificationRepository: createNotificationRepository(pool, { now }),
    scheduleService: createScheduleService({ repository: createScheduleRepository(pool), now }),
    suggestionService: createSuggestionService({ repository: createSuggestionRepository(pool, { logger }), now }),
    ...createCalendarServices({ pool, logger, lmsConfig, icloudFetchFn, now, limit }),
  }
}
