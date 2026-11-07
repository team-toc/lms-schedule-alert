// Google OAuth(OpenID Connect) 토큰 교환과 id_token 확인만 담당하는 경계 레이어 (ADR 0006).
// 인가 코드 · 토큰 · id_token · client_secret은 에러 메시지에 넣지 않는다.
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
// 이메일은 요청하지 않는다. access_type을 보내지 않아(기본 online) refresh token도 받지 않는다.
const SCOPE = 'openid profile'
const ALLOWED_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
const SUB_MAX_LENGTH = 255
const REQUEST_TIMEOUT_MS = 5000
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=utf-8'
const JWT_PART_COUNT = 3
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const MS_PER_SECOND = 1000

export class GoogleApiError extends Error {
  // stage: 'token_exchange' | 'id_token', reason: 원인 파악용 고정 문자열 (예: invalid_aud)
  constructor(stage, { status = null, googleError = null, reason = null, cause } = {}) {
    super(`Google API 요청 실패: ${stage}${status ? ` (HTTP ${status})` : ''}${reason ? ` ${reason}` : ''}`, { cause })
    this.name = 'GoogleApiError'
    this.stage = stage
    this.status = status
    this.googleError = googleError
    this.reason = reason
  }
}

// 하나라도 거짓이면 그 reason으로 거부한다. 시계 오차는 허용하지 않는다(exp가 지금이면 거부).
const CLAIM_CHECKS = [
  ['invalid_iss', (claims) => ALLOWED_ISSUERS.has(claims.iss)],
  ['invalid_aud', (claims, expected) => claims.aud === expected.clientId],
  ['invalid_exp', (claims) => Number.isFinite(claims.exp)],
  ['expired', (claims, expected) => claims.exp * MS_PER_SECOND > expected.nowMs],
  ['invalid_nonce', (claims, expected) => typeof expected.nonce === 'string' && expected.nonce !== '' && claims.nonce === expected.nonce],
  ['invalid_sub', (claims) => typeof claims.sub === 'string' && claims.sub !== '' && claims.sub.length <= SUB_MAX_LENGTH],
]

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function decodeJwtPart(part) {
  if (!BASE64URL_PATTERN.test(part)) {
    throw new GoogleApiError('id_token', { reason: 'malformed' })
  }
  let value
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch (err) {
    throw new GoogleApiError('id_token', { reason: 'malformed', cause: err })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GoogleApiError('id_token', { reason: 'malformed' })
  }
  return value
}

// 서명은 검증하지 않는다: 토큰 엔드포인트와 직접 TLS로 통신하고 client_secret으로 인증했기 때문 (ADR 0006).
// 그래서 이 함수는 공개하지 않고, 이 모듈이 토큰 엔드포인트에서 직접 받은 id_token에만 쓴다.
function verifyIdTokenClaims(idToken, expected) {
  const parts = idToken.split('.')
  if (parts.length !== JWT_PART_COUNT) {
    throw new GoogleApiError('id_token', { reason: 'malformed' })
  }
  decodeJwtPart(parts[0])
  const claims = decodeJwtPart(parts[1])
  const failed = CLAIM_CHECKS.find(([, isValid]) => !isValid(claims, expected))
  if (failed) {
    throw new GoogleApiError('id_token', { reason: failed[0] })
  }
  return claims
}

// 인가 코드는 일회용이라 실패해도 재시도하지 않는다
async function requestTokens({ config, fetchFn, timeoutMs }, code) {
  const form = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  })
  let res
  try {
    res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': FORM_CONTENT_TYPE },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new GoogleApiError('token_exchange', { cause: err })
  }
  const body = await readJson(res)
  if (!res.ok) {
    // Google error 코드(예: invalid_grant)만 원인 파악용으로 남긴다. 응답 본문 전체는 남기지 않는다.
    const googleError = typeof body?.error === 'string' ? body.error : null
    throw new GoogleApiError('token_exchange', { status: res.status, googleError })
  }
  if (typeof body?.id_token !== 'string') {
    throw new GoogleApiError('token_exchange', { status: res.status, reason: 'missing_id_token' })
  }
  return body
}

export function createGoogleClient({ config, fetchFn = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const { clientId, redirectUri } = config

  function buildAuthorizeUrl({ state, nonce }) {
    const url = new URL(AUTHORIZE_URL)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      state,
      nonce,
    }).toString()
    return url.toString()
  }

  // 토큰은 로그인 확인에만 쓰고 돌려주지 않는다. sub와 표시 이름만 꺼낸다.
  async function exchangeCodeForProfile(code, { nonce }) {
    const { id_token: idToken } = await requestTokens({ config, fetchFn, timeoutMs }, code)
    const claims = verifyIdTokenClaims(idToken, { clientId, nonce, nowMs: Date.now() })
    return { id: claims.sub, nickname: typeof claims.name === 'string' ? claims.name : null }
  }

  return { buildAuthorizeUrl, exchangeCodeForProfile }
}
