// Canvas 토큰 등록 (ADR 0008): Canvas에 확인(/users/self) → 암호화 저장 + onboarding 완료 → 첫 동기화는 백그라운드.
// 확인이 실패하면 아무것도 저장하지 않는다.
import { CanvasApiError, CANVAS_ERRORS } from '../canvas/canvas-client.js'
import { parseCanvasAccountId } from './canvas-account-id.js'

const TOKEN_REJECTED = {
  status: 400,
  error: 'canvas_token_rejected',
  field: 'token',
  message: 'Canvas가 이 토큰을 받아 주지 않습니다. 토큰을 다시 확인해 주세요.',
}
const CANVAS_UNAVAILABLE = { status: 502, error: 'canvas_unavailable', message: 'Canvas에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' }
// Canvas 오류 코드 → 응답. 표에 없는 것(네트워크 · 5xx · 리다이렉트 등)은 502 canvas_unavailable
const REGISTER_FAILURES = new Map([
  [CANVAS_ERRORS.unauthorized, TOKEN_REJECTED],
  [CANVAS_ERRORS.forbidden, TOKEN_REJECTED],
  [CANVAS_ERRORS.rateLimited, { status: 503, error: 'canvas_rate_limited', message: 'Canvas 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.' }],
  [CANVAS_ERRORS.timeout, { status: 504, error: 'canvas_timeout', message: 'Canvas 응답이 늦습니다. 잠시 후 다시 시도해 주세요.' }],
])

// 계정 id를 쓸 수 없으면(같은 계정 판단 불가 → 기준 동기화) 운영에서 알아챌 수 있게 경고. 이유 코드만, id 값은 남기지 않는다
function accountIdOf(self, { logger, userId }) {
  const { id, reason } = parseCanvasAccountId(self.id)
  if (reason) {
    logger.warn({ event: 'lms_canvas_account_id_unusable', userId, reason }, 'canvas account id unusable, treated as a different account')
  }
  return id
}

export function createTokenService({ canvasClient, tokenCipher, tokenRepository, syncRunner, now, logger }) {
  // 결과: { ok: true } 또는 { failure: { status, error, message, field? }, canvasError }
  async function registerToken(userId, token) {
    let self
    try {
      self = await canvasClient.getSelf(token)
    } catch (err) {
      if (!(err instanceof CanvasApiError)) {
        throw err
      }
      return { failure: REGISTER_FAILURES.get(err.code) ?? CANVAS_UNAVAILABLE, canvasError: err.code }
    }
    const canvasUserId = accountIdOf(self, { logger, userId })
    await tokenRepository.saveToken({ userId, tokenEnc: tokenCipher.encrypt(token, { userId }), canvasUserId, now: now() })
    syncRunner.requestSync(userId)
    return { ok: true }
  }

  // 상태 응답: 시각은 UTC ISO. 토큰 · 암호문은 넣지 않는다
  async function getStatus(userId) {
    const state = await tokenRepository.findToken(userId)
    if (!state) {
      return { status: 'not_connected' }
    }
    return {
      status: state.status,
      connectedAt: state.connectedAt.toISOString(),
      lastSyncedAt: state.lastSyncedAt?.toISOString() ?? null,
      lastErrorCode: state.lastErrorCode,
    }
  }

  return { registerToken, getStatus, deleteToken: (userId) => tokenRepository.deleteToken(userId) }
}
