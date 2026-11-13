// 수동 동기화 요청 (ADR 0008). 사용자당 5분에 한 번, 백그라운드로 실행(동시 실행 상한은 실행기가 지킨다).
// 쿨다운 기록은 프로세스 메모리(서버 한 대). 키는 사용자 id라 등록된 사용자 수를 넘지 않는다.
const COOLDOWN_MS = 5 * 60 * 1000
const MS_PER_SECOND = 1000

export function createManualSync({ tokenRepository, syncRunner, now, cooldownMs = COOLDOWN_MS }) {
  const lastRequestedAt = new Map()

  // 결과: { status } | { error: 'lms_not_connected' | 'lms_needs_reauth' } | { error: 'sync_too_frequent', retryAfterSeconds }
  async function requestSync(userId) {
    const state = await tokenRepository.findToken(userId)
    if (!state) {
      return { error: 'lms_not_connected' }
    }
    if (state.status === 'needs_reauth') {
      return { error: 'lms_needs_reauth' }
    }
    const nowMs = now().getTime()
    const last = lastRequestedAt.get(userId)
    if (last !== undefined && nowMs - last < cooldownMs) {
      return { error: 'sync_too_frequent', retryAfterSeconds: Math.ceil((cooldownMs - (nowMs - last)) / MS_PER_SECOND) }
    }
    lastRequestedAt.set(userId, nowMs)
    syncRunner.requestSync(userId)
    return { status: state.status }
  }

  return { requestSync }
}
