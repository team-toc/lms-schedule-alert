// 브라우저 푸시 발송 (경계 레이어, ADR 0012). web-push로는 암호화 본문(aes128gcm, RFC 8291) · VAPID 헤더(RFC 8292)만 만들고,
// 보내기는 주입한 fetch로: 리다이렉트를 따라가지 않고, 요청마다 타임아웃 신호(신호 만드는 함수 주입 — 테스트가 실제 타이머를 기다리지 않게).
// 던지지 않는다: 결과는 { outcome: 'sent' | 'expired' | 'failed', code }. endpoint · 키 · payload는 결과 · 에러에 넣지 않는다.
// web-push의 모듈 전역 설정(setVapidDetails · GCM 키)은 쓰지 않고 호출마다 넘긴다.
import webpush from 'web-push'
import { isAllowedPushEndpoint } from './push-subscription-input.js'

export const PUSH_TTL_SECONDS = 24 * 60 * 60
export const PUSH_TIMEOUT_MS = 5000
// RFC 8291 4절: 푸시 서비스가 받아야 하는 4096바이트 본문 = 평문 최대 3993바이트
const MAX_PLAINTEXT_BYTES = 3993
const EXPIRED_STATUSES = new Set([404, 410])
const REDIRECT_MIN = 300
const REDIRECT_MAX = 399

const result = (outcome, code = null) => ({ outcome, code })
const isTimeout = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError'

function outcomeOf(status) {
  if (status >= 200 && status < REDIRECT_MIN) return result('sent')
  if (EXPIRED_STATUSES.has(status)) return result('expired', `http_${status}`)
  if (status >= REDIRECT_MIN && status <= REDIRECT_MAX) return result('failed', 'redirect')
  return result('failed', `http_${status}`)
}

// Urgency는 보내지 않는다(Safari가 'normal'에 400 BadUrgency라는 보고, web-push는 항상 붙임). Content-Length는 fetch가 계산
function requestOf({ endpoint, p256dh, auth }, payload, { topic, vapid }) {
  const details = webpush.generateRequestDetails({ endpoint, keys: { p256dh, auth } }, payload, {
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: PUSH_TTL_SECONDS,
    contentEncoding: 'aes128gcm',
    topic,
  })
  const headers = Object.fromEntries(
    Object.entries(details.headers)
      .filter(([name]) => !['urgency', 'content-length'].includes(name.toLowerCase()))
      .map(([name, value]) => [name, String(value)]),
  )
  return { url: details.endpoint, headers, body: details.body }
}

export function createPushSender({ fetchFn = globalThis.fetch, vapid, timeoutMs = PUSH_TIMEOUT_MS, createTimeoutSignal = (ms) => AbortSignal.timeout(ms) }) {
  async function send(target, payload, { topic } = {}) {
    if (!isAllowedPushEndpoint(target?.endpoint)) return result('failed', 'endpoint_not_allowed')
    if (Buffer.byteLength(payload, 'utf8') > MAX_PLAINTEXT_BYTES) return result('failed', 'payload_too_large')
    let req
    try {
      req = requestOf(target, payload, { topic, vapid })
    } catch {
      return result('failed', 'encrypt_failed')
    }
    let res
    try {
      res = await fetchFn(req.url, { method: 'POST', headers: req.headers, body: req.body, redirect: 'manual', signal: createTimeoutSignal(timeoutMs) })
    } catch (err) {
      return result('failed', isTimeout(err) ? 'timeout' : 'network')
    }
    await res.body?.cancel().catch(() => {})
    return outcomeOf(res.status)
  }

  return { send }
}
