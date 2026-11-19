// 브라우저 푸시 구독 입력 검사 (ADR 0012). 오류는 처음 하나만 { code, field }로.
// - endpoint: 문자열 · 2048자 이하 · https · 계정 정보 없음 · 포트 없음(443) · 호스트가 알려진 브라우저 푸시 서비스
//   (정확히 같거나 점 경계 접미사, 대소문자 무시, IP · 끝 점 거부). endpoint 문자열은 바꾸지 않는다(그대로 보내야 함)
// - keys.p256dh: base64url · 65바이트 · 0x04(P-256 비압축), keys.auth: base64url · 16바이트
export const MAX_ENDPOINT_LENGTH = 2048

// 브라우저가 고르는 푸시 서비스 호스트 (ADR 0012 표). Chrome(fcm.googleapis.com)은 2026-11-18 실제 구독으로 확인
const PUSH_SERVICE_SUFFIXES = ['fcm.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com']
const BASE64URL = /^[A-Za-z0-9_-]+$/
const P256DH_BYTES = 65
const AUTH_BYTES = 16

const fail = (code, field) => ({ error: { code, field } })

// IP 주소는 어떤 접미사와도 맞지 않아 따로 막지 않아도 거부된다(테스트로 고정)
function isAllowedHost(hostname) {
  const host = hostname.toLowerCase()
  return PUSH_SERVICE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

// 문자열 · 길이(해제 입력도 같은 규칙)
function checkEndpointString(value) {
  if (value === undefined || value === null || value === '') return fail('missing_endpoint', 'endpoint')
  if (typeof value !== 'string') return fail('invalid_endpoint', 'endpoint')
  return value.length > MAX_ENDPOINT_LENGTH ? fail('endpoint_too_long', 'endpoint') : { value }
}

function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

// 문자열 · 길이 → URL 모양 → https → 계정 정보 · 포트 → 호스트
function checkEndpoint(value) {
  const text = checkEndpointString(value)
  if (text.error) return text
  const url = parseUrl(value)
  if (!url) return fail('invalid_endpoint', 'endpoint')
  if (url.protocol !== 'https:') return fail('insecure_endpoint', 'endpoint')
  if (url.username || url.password || url.port !== '') return fail('invalid_endpoint', 'endpoint')
  return isAllowedHost(url.hostname) ? { value } : fail('push_service_not_allowed', 'endpoint')
}

// 다시 인코딩해 같은 문자열일 때만(패딩 · 표준 base64 거부)
function decodeBase64url(value) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  return bytes.toString('base64url') === value ? bytes : null
}

function checkKeys(keys) {
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) return fail('missing_keys', 'keys')
  const p256dh = decodeBase64url(keys.p256dh)
  if (!p256dh || p256dh.length !== P256DH_BYTES || p256dh[0] !== 0x04) return fail('invalid_p256dh', 'keys.p256dh')
  const auth = decodeBase64url(keys.auth)
  if (!auth || auth.length !== AUTH_BYTES) return fail('invalid_auth', 'keys.auth')
  return { value: { p256dh: keys.p256dh, auth: keys.auth } }
}

// 등록. 결과: { value: { endpoint, p256dh, auth } } | { error }
export function parsePushSubscription(body) {
  const endpoint = checkEndpoint(body?.endpoint)
  if (endpoint.error) return endpoint
  const keys = checkKeys(body.keys)
  if (keys.error) return keys
  return { value: { endpoint: endpoint.value, ...keys.value } }
}

// 해제. 문자열 · 길이만 본다(허용 목록 밖 주소는 "내 구독 없음"으로 404). 결과: { value: endpoint } | { error }
export function parsePushEndpoint(body) {
  return checkEndpointString(body?.endpoint)
}

// 보내기 직전 다시 검사(저장 뒤 목록이 바뀌었거나 DB가 오염된 경우)
export function isAllowedPushEndpoint(value) {
  return !checkEndpoint(value).error
}
