// Canvas 연동 서비스 조립 (ADR 0008). 서버 진입점과 테스트가 같은 함수로 만든다.
// 바깥 의존(DB 풀 · fetch · 시계 · 로거)은 주입받는다.
import { createCanvasClient } from '../canvas/canvas-client.js'
import { createTokenCipher } from './token-cipher.js'
import { createLmsTokenRepository } from './lms-token-repository.js'
import { createLmsSyncRepository } from './lms-sync-repository.js'
import { createLmsSync } from './lms-sync.js'
import { createSyncRunner } from './sync-runner.js'
import { createTokenService } from './token-service.js'

export function createLmsServices({ pool, logger, lmsConfig, fetchFn = globalThis.fetch, now = () => new Date() }) {
  const canvasClient = createCanvasClient({ baseUrl: lmsConfig.canvasBaseUrl, fetchFn })
  const tokenCipher = createTokenCipher({ key: lmsConfig.tokenKey })
  const tokenRepository = createLmsTokenRepository(pool, { logger })
  const syncRepository = createLmsSyncRepository(pool, { logger })
  const lmsSync = createLmsSync({ canvasClient, tokenCipher, tokenRepository, syncRepository, baseUrl: lmsConfig.canvasBaseUrl, now, logger })
  const syncRunner = createSyncRunner({ lmsSync, logger })
  const tokenService = createTokenService({ canvasClient, tokenCipher, tokenRepository, syncRunner, now })
  return { lmsSync, syncRunner, tokenService }
}
