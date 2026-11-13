// 동기화 실행기 (ADR 0008). 5단계: 요청받은 사용자의 백그라운드 동기화(토큰 등록 직후 첫 동기화).
// 주기 실행(start · stop · runOnce)은 6단계에서 더한다.
export function createSyncRunner({ lmsSync, logger }) {
  const inFlight = new Set()

  // 응답을 기다리게 하지 않고 백그라운드로 돌린다. 예상 못 한 예외(DB 등)는 로그만 남기고 삼킨다.
  function requestSync(userId) {
    const run = lmsSync
      .syncUser(userId)
      // 동기화 안의 에러는 lmsSync가 잡아 failing으로 기록한다. 여기까지 오는 것은 잠금 연결조차 못 얻은 경우 등(기록 불가)
      .catch((err) => {
        logger.error({ event: 'lms_sync_crashed', userId, err: { name: err?.name, code: err?.code } }, 'lms sync crashed')
        return { outcome: 'failed', errorCode: 'internal_error' }
      })
      .finally(() => inFlight.delete(run))
    inFlight.add(run)
    return run
  }

  // 지금 돌고 있는 백그라운드 동기화가 모두 끝날 때까지 (테스트 · 종료 처리용)
  async function whenIdle() {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight])
    }
  }

  return { requestSync, whenIdle }
}
