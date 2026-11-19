// Canvas 반영이 커밋된 뒤의 후속 단계들을 차례로 (ADR 0011 · 0012: 푸시 발송 준비 → 공지 일정 제안).
// 단계마다 에러를 따로 잡는다: 한 단계가 실패해도 다음 단계는 돌고, Canvas 동기화 결과(applied)는 바뀌지 않는다.
// 에러는 이름 · 코드만 로그(메시지 · 값 없음)
export function composeAfterAppliedSteps(steps, logger) {
  return async function runSteps(input) {
    for (const { name, run } of steps) {
      try {
        await run(input)
      } catch (err) {
        logger.error({ event: 'after_applied_step_failed', step: name, userId: input.userId, err: { name: err?.name, code: err?.code } }, 'after-applied step failed')
      }
    }
  }
}
