// 동기화 뒤 발송 준비 단계 (ADR 0012). afterApplied 훅에서 사용자 잠금 안에 돈다: 대상 알림과 그 사용자 구독 id만 읽고
// 메시지를 만들어 발송기에 넣는다. 실제 발송은 잠금을 푼 뒤 발송기가 한다(이 단계는 기다리지 않음)
import { buildPushMessages, testPushMessage } from './push-payload.js'

const jobsFor = (userId, subscriptions, messages) =>
  messages.flatMap((m) => subscriptions.map((s) => ({ subscriptionId: s.id, userId, endpointHash: s.endpointHash, payload: m.payload, topic: m.topic })))

export function createPushStep({ pushTargets, repository, dispatcher }) {
  async function afterSync({ userId, at }) {
    const notifications = await pushTargets(userId, at)
    if (notifications.length === 0) return
    const subscriptions = await repository.listForUser(userId)
    if (subscriptions.length === 0) return
    dispatcher.enqueue(jobsFor(userId, subscriptions, buildPushMessages(notifications)))
  }

  // 개발용 테스트 발송: 내 구독마다 하나. 결과: 넣은 일감 수
  async function sendTest(userId) {
    const subscriptions = await repository.listForUser(userId)
    dispatcher.enqueue(jobsFor(userId, subscriptions, [testPushMessage()]))
    return subscriptions.length
  }

  return { afterSync, sendTest }
}
