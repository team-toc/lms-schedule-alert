// 브라우저 푸시 구독 등록 · 해제 (ADR 0012). 입력 검사 → 암호화(용도 push_subscription:<user_id>) · HMAC → 저장.
// 같은 endpoint를 다른 사용자가 등록하면 그 사용자 기준으로 다시 암호화해 주인이 바뀐다(이전 계정의 알림이 그 브라우저로 가지 않게).
// 결과: { status: 'created' | 'updated' } | { deleted: true } | { failure: { status, error, field? } }
import { parsePushSubscription, parsePushEndpoint } from './push-subscription-input.js'

export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10

const NOT_FOUND = { failure: { status: 404, error: 'push_subscription_not_found' } }
const badRequest = ({ code, field }) => ({ failure: { status: 400, error: code, field } })

export function createPushSubscriptionService({ repository, cipher, hashEndpoint }) {
  async function register(userId, body) {
    const { value, error } = parsePushSubscription(body)
    if (error) {
      return badRequest(error)
    }
    const subscriptionEnc = cipher.encrypt(JSON.stringify(value), { userId })
    const status = await repository.upsert({ userId, endpointHash: hashEndpoint(value.endpoint), subscriptionEnc, max: MAX_PUSH_SUBSCRIPTIONS_PER_USER })
    return { status }
  }

  async function unregister(userId, body) {
    const { value, error } = parsePushEndpoint(body)
    if (error) {
      return badRequest(error)
    }
    return (await repository.deleteMine({ userId, endpointHash: hashEndpoint(value) })) ? { deleted: true } : NOT_FOUND
  }

  return { register, unregister }
}
