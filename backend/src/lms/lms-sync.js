// 사용자 한 명의 Canvas 동기화 (ADR 0008).
// 1) 사용자 잠금 → 2) 토큰 복호화 → 3) Canvas에서 전부 받기(canvas-snapshot.js)
// → 4) 다 받았을 때만 한 트랜잭션으로 반영. 중간에 실패하면 아무것도 반영하지 않는다(일부 목록으로 삭제를 판단하지 않음).
import { CanvasApiError, CANVAS_ERRORS } from '../canvas/canvas-client.js'
import { TokenDecryptError } from './token-cipher.js'
import { createSnapshotFetcher } from './canvas-snapshot.js'

// 저장된 암호문을 지금 키로 풀 수 없음(키가 바뀜 등) → 사용자가 토큰을 다시 등록해야 한다
export const TOKEN_UNREADABLE = 'token_unreadable'
const NEEDS_REAUTH_CODES = new Set([CANVAS_ERRORS.unauthorized, TOKEN_UNREADABLE])
// Canvas 오류가 아닌 예상 밖 에러(DB 오류 · 코드 버그 등)
export const INTERNAL_ERROR = 'internal_error'

// 복호화할 수 없으면 null (형식 오류 · 키 변경 · 다른 사용자 행)
function decryptOrNull(tokenCipher, tokenEnc, userId) {
  try {
    return tokenCipher.decrypt(tokenEnc, { userId })
  } catch (err) {
    if (err instanceof TokenDecryptError) {
      return null
    }
    throw err
  }
}

// 동기화 안에서 예상 밖 에러가 나면: 이름 · 코드만 로그로 남기고(메시지 · SQL 값은 남기지 않음) 상태를 failing으로 기록한다.
// 기록까지 실패해도(DB가 끊김 등) 던지지 않는다. 백그라운드 동기화에서 처리되지 않은 Promise 거부가 생기지 않게.
async function recordCrash({ tokenRepository, logger }, scope, err) {
  logger.error({ event: 'lms_sync_crashed', userId: scope.userId, err: { name: err?.name, code: err?.code } }, 'lms sync crashed')
  if (scope.tokenEnc) {
    try {
      await tokenRepository.recordFailure({ ...scope, status: 'failing', errorCode: INTERNAL_ERROR })
    } catch (recordError) {
      logger.error(
        { event: 'lms_sync_failure_not_recorded', userId: scope.userId, err: { name: recordError?.name, code: recordError?.code } },
        'could not record lms sync failure',
      )
    }
  }
  return { outcome: 'failed', errorCode: INTERNAL_ERROR }
}

export function createLmsSync({ canvasClient, tokenCipher, tokenRepository, syncRepository, baseUrl, now, logger }) {
  const { fetchSnapshot } = createSnapshotFetcher({ canvasClient, baseUrl, logger })

  async function fail({ userId, tokenEnc }, errorCode, details = {}) {
    const status = NEEDS_REAUTH_CODES.has(errorCode) ? 'needs_reauth' : 'failing'
    await tokenRepository.recordFailure({ userId, tokenEnc, status, errorCode })
    logger.warn({ event: 'lms_sync_failed', userId, errorCode, status, ...details }, 'lms sync failed')
    return { outcome: 'failed', errorCode }
  }

  // scope.tokenEnc는 토큰 행을 읽은 뒤 채운다(예상 밖 에러 때 어느 토큰의 실패인지 기록하려고)
  async function runSync(scope) {
    const { userId } = scope
    const state = await tokenRepository.findToken(userId)
    if (!state) {
      return { outcome: 'skipped', reason: 'not_connected' }
    }
    scope.tokenEnc = state.tokenEnc
    const token = decryptOrNull(tokenCipher, state.tokenEnc, userId)
    if (token === null) {
      return fail(scope, TOKEN_UNREADABLE)
    }
    const at = now()
    let snapshot
    try {
      snapshot = await fetchSnapshot(token, { userId, at })
    } catch (err) {
      if (!(err instanceof CanvasApiError)) {
        throw err
      }
      return fail(scope, err.code, { canvasStatus: err.status, canvasPath: err.path })
    }
    if (!(await syncRepository.applySnapshot({ ...scope, snapshot, now: at }))) {
      logger.info({ event: 'lms_sync_discarded', userId, reason: 'token_changed' }, 'token changed during sync, result discarded')
      return { outcome: 'skipped', reason: 'token_changed' }
    }
    logger.info({ event: 'lms_sync_applied', userId, courses: snapshot.courses.length }, 'lms sync applied')
    return { outcome: 'applied' }
  }

  // 결과: { outcome: 'applied' } | { outcome: 'failed', errorCode } | { outcome: 'skipped', reason }
  async function syncUser(userId) {
    const scope = { userId, tokenEnc: null }
    const work = () => runSync(scope).catch((err) => recordCrash({ tokenRepository, logger }, scope, err))
    const { acquired, result } = await tokenRepository.withSyncLock(userId, work)
    return acquired ? result : { outcome: 'skipped', reason: 'already_running' }
  }

  return { syncUser }
}
