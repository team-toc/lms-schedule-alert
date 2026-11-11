import { GOOGLE_TEST_CONFIG } from './test-db.js'

export const GOOGLE_ISSUER = 'https://accounts.google.com'
export const DEFAULT_GOOGLE_SUB = '109876543210987654321'
export const DEFAULT_GOOGLE_NAME = '구글사용자'
const TOKEN_LIFETIME_SECONDS = 3600

export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export function base64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
}

// 서명은 검증하지 않으므로(ADR 0006) 세 번째 부분은 아무 값이나 넣는다
export function makeIdToken(claims, { header = { alg: 'RS256', typ: 'JWT', kid: 'fake-kid' } } = {}) {
  return `${base64url(header)}.${base64url(claims)}.fake-signature`
}

// 통과해야 하는 기본 클레임. overrides로 하나씩 깨뜨려 거부되는지 본다.
export function idTokenClaims({ nonce, ...overrides }) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    iss: GOOGLE_ISSUER,
    aud: GOOGLE_TEST_CONFIG.clientId,
    sub: DEFAULT_GOOGLE_SUB,
    name: DEFAULT_GOOGLE_NAME,
    nonce,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
    ...overrides,
  }
}

export function tokenResponseBody(idToken, code = 'code') {
  return {
    access_token: `fake-google-access-token-${code}`,
    expires_in: 3599,
    id_token: idToken,
    scope: 'openid profile',
    token_type: 'Bearer',
  }
}

// 응답 흉내: 네트워크 오류, 응답 없음(타임아웃까지 대기)
export const networkError = () => {
  throw new TypeError('fetch failed')
}
export const neverResponds = (init) =>
  new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
  })

// 실제 Google 대신 토큰 엔드포인트를 흉내 내는 fetch.
// 인가 코드별로 응답을 정해 두고(issueIdToken · respond), 정하지 않은 코드는 400 invalid_grant.
export function createFakeGoogleTokenEndpoint() {
  const requests = []
  const responders = new Map()
  const fetchFn = async (url, init = {}) => {
    requests.push({ url: String(url), ...init })
    const code = new URLSearchParams(String(init.body ?? '')).get('code')
    const respond = responders.get(code) ?? (() => jsonResponse(400, { error: 'invalid_grant' }))
    return respond(init)
  }
  return {
    fetchFn,
    requests,
    issueIdToken(code, claims) {
      responders.set(code, () => jsonResponse(200, tokenResponseBody(makeIdToken(claims), code)))
    },
    respond(code, responder) {
      responders.set(code, responder)
    },
  }
}
