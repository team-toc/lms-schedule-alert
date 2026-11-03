// 카카오 OAuth · 사용자 API 호출만 담당하는 경계 레이어.
// 인가 코드 · 토큰 · client_secret은 에러 메시지에 넣지 않는다.
const AUTHORIZE_URL = 'https://kauth.kakao.com/oauth/authorize'
const TOKEN_URL = 'https://kauth.kakao.com/oauth/token'
const USER_PROFILE_URL = 'https://kapi.kakao.com/v2/user/me'
const REQUEST_TIMEOUT_MS = 5000
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=utf-8'

export class KakaoApiError extends Error {
  // stage: 'token_exchange' | 'user_profile'
  constructor(stage, { status = null, kakaoErrorCode = null, cause } = {}) {
    super(`카카오 API 요청 실패: ${stage}${status ? ` (HTTP ${status})` : ''}`, { cause })
    this.name = 'KakaoApiError'
    this.stage = stage
    this.status = status
    this.kakaoErrorCode = kakaoErrorCode
  }
}

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

async function requestJson(fetchFn, stage, url, init) {
  let res
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    throw new KakaoApiError(stage, { cause: err })
  }
  const body = await readJson(res)
  if (!res.ok) {
    // error_code(예: KOE320)는 원인 파악용으로만 남긴다. 응답 본문 전체는 남기지 않는다.
    throw new KakaoApiError(stage, { status: res.status, kakaoErrorCode: body?.error_code ?? null })
  }
  if (body === null) {
    throw new KakaoApiError(stage, { status: res.status })
  }
  return body
}

export function createKakaoClient({ config, fetchFn = globalThis.fetch }) {
  const { restApiKey, clientSecret, redirectUri } = config

  function buildAuthorizeUrl(state) {
    const url = new URL(AUTHORIZE_URL)
    url.search = new URLSearchParams({
      client_id: restApiKey,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    }).toString()
    return url.toString()
  }

  // 인가 코드는 일회용이라 실패해도 재시도하지 않는다
  async function exchangeCodeForToken(code) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: restApiKey,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    })
    const body = await requestJson(fetchFn, 'token_exchange', TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': FORM_CONTENT_TYPE },
      body: form.toString(),
    })
    if (typeof body.access_token !== 'string') {
      throw new KakaoApiError('token_exchange')
    }
    return body.access_token
  }

  // 사용자 고유 id와 닉네임만 꺼낸다. 이메일 등 다른 항목은 쓰지 않는다.
  async function fetchUserProfile(accessToken) {
    const body = await requestJson(fetchFn, 'user_profile', USER_PROFILE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (body.id === undefined || body.id === null) {
      throw new KakaoApiError('user_profile')
    }
    const nickname = body.kakao_account?.profile?.nickname ?? body.properties?.nickname ?? null
    return { id: String(body.id), nickname }
  }

  return { buildAuthorizeUrl, exchangeCodeForToken, fetchUserProfile }
}
