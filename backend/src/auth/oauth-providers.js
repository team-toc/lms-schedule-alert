import { KakaoApiError } from '../kakao/kakao-client.js'
import { GoogleApiError } from '../google/google-client.js'

// 공통 OAuth 흐름(oauth-flow.js)에 넘기는 제공자 정보 (ADR 0006).
// sessionKey: 로그인 시도를 저장할 세션 키. 제공자마다 달라서 다른 제공자의 state로는 콜백을 통과할 수 없다.
// usesNonce: true면 세션에 { state, nonce } 객체를, false면 state 문자열만 저장한다.
export function createKakaoProvider(kakaoClient) {
  return {
    name: 'kakao',
    // 리팩터링 전과 같은 키 · 같은 모양(state 문자열)을 유지한다
    sessionKey: 'oauthState',
    usesNonce: false,
    buildAuthorizeUrl: ({ state }) => kakaoClient.buildAuthorizeUrl(state),
    // 액세스 토큰은 사용자 조회에만 쓰고 저장하지 않는다
    async fetchProfile({ code }) {
      const accessToken = await kakaoClient.exchangeCodeForToken(code)
      return kakaoClient.fetchUserProfile(accessToken)
    },
    isApiError: (err) => err instanceof KakaoApiError,
    describeFailure: (err) => ({ stage: err.stage, status: err.status, kakaoErrorCode: err.kakaoErrorCode }),
    errors: { denied: 'kakao_login_denied', apiFailed: 'kakao_api_failed' },
  }
}

export function createGoogleProvider(googleClient) {
  return {
    name: 'google',
    // nonce가 필요해 { state, nonce } 객체로 저장한다 (카카오와 모양이 다른 것은 의도)
    sessionKey: 'googleOAuth',
    usesNonce: true,
    buildAuthorizeUrl: ({ state, nonce }) => googleClient.buildAuthorizeUrl({ state, nonce }),
    // 토큰은 클라이언트 안에서 id_token 확인에만 쓰고 여기까지 오지 않는다
    fetchProfile: ({ code, nonce }) => googleClient.exchangeCodeForProfile(code, { nonce }),
    isApiError: (err) => err instanceof GoogleApiError,
    describeFailure: (err) => ({ stage: err.stage, status: err.status, googleError: err.googleError, failureReason: err.reason }),
    errors: { denied: 'google_login_denied', apiFailed: 'google_api_failed' },
  }
}
