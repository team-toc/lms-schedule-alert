// 브라우저 푸시 서비스 조립 (ADR 0012). createLmsServices가 Canvas와 같은 풀 · 로거 · 키로 부른다.
// 구독 암호화는 Canvas 토큰과 같은 키, 용도(AAD)만 다르게. 중복 확인 해시 키는 같은 키에서 HKDF로 파생.
// push.config가 없으면 null(푸시 라우트는 503 push_unavailable).
import { createTokenCipher, CIPHER_CONTEXTS } from '../lms/token-cipher.js'
import { createPushEndpointHasher } from './push-endpoint-hash.js'
import { createPushSubscriptionRepository } from './push-subscription-repository.js'
import { createPushSubscriptionService } from './push-subscription-service.js'
import { createPushSender } from './push-sender.js'
import { createPushDispatcher } from './push-dispatcher.js'
import { createPushNotificationQuery } from './push-notification-query.js'
import { createPushStep } from './push-step.js'

// push = { config, fetchFn, maxPending? }. 결과의 step.afterSync는 afterApplied 단계, dispatcher는 서버 종료 대상
export function createPushServices({ pool, logger, lmsConfig, push, now }) {
  if (!push?.config) {
    return null
  }
  const cipher = createTokenCipher({ key: lmsConfig.tokenKey, context: CIPHER_CONTEXTS.pushSubscription })
  const repository = createPushSubscriptionRepository(pool, { logger })
  const { vapidPublicKey, vapidPrivateKey, vapidSubject } = push.config
  const sender = createPushSender({ fetchFn: push.fetchFn, vapid: { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject } })
  const dispatcher = createPushDispatcher({ sender, repository, cipher, logger, now, ...(push.maxPending ? { maxPending: push.maxPending } : {}) })
  return {
    publicKey: vapidPublicKey,
    subscriptionService: createPushSubscriptionService({ repository, cipher, hashEndpoint: createPushEndpointHasher({ key: lmsConfig.tokenKey }) }),
    dispatcher,
    step: createPushStep({ pushTargets: createPushNotificationQuery(pool), repository, dispatcher }),
  }
}
