import { KakaoApiError } from '../../src/kakao/kakao-client.js'

export const FAKE_AUTHORIZE_URL = 'https://kauth.fake/oauth/authorize'
export const DEFAULT_PROFILE = { id: '4000000001', nickname: '테스트사용자' }

// 실제 카카오를 부르지 않는 가짜 클라이언트.
// failAt: 'token' | 'profile' 이면 그 단계에서 KakaoApiError를 던진다.
export function createFakeKakaoClient({ profile = DEFAULT_PROFILE, failAt = null } = {}) {
  const calls = { exchange: [], profile: [] }
  return {
    calls,
    buildAuthorizeUrl(state) {
      return `${FAKE_AUTHORIZE_URL}?state=${encodeURIComponent(state)}`
    },
    async exchangeCodeForToken(code) {
      calls.exchange.push(code)
      if (failAt === 'token') {
        throw new KakaoApiError('token_exchange', { status: 401 })
      }
      return `fake-access-token-${code}`
    },
    async fetchUserProfile(accessToken) {
      calls.profile.push(accessToken)
      if (failAt === 'profile') {
        throw new KakaoApiError('user_profile', { status: 401 })
      }
      return profile
    },
  }
}
