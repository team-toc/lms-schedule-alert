import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createKakaoClient, KakaoApiError } from '../src/kakao/kakao-client.js'
import { timeoutError } from './helpers/fake-google.js'

const KAKAO_CONFIG = {
  restApiKey: 'fake-rest-api-key',
  clientSecret: 'fake-client-secret',
  redirectUri: 'http://backend.test/api/auth/kakao/callback',
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// 실제 네트워크 대신 요청을 기록하고 정해 둔 응답을 돌려주는 fetch
function createFakeFetch(response) {
  const requests = []
  const fetchFn = async (url, init = {}) => {
    requests.push({ url: String(url), ...init })
    if (response instanceof Error) {
      throw response
    }
    return response
  }
  return { fetchFn, requests }
}

describe('카카오 클라이언트 (경계 레이어)', () => {
  it('인가 URL에 client_id · redirect_uri · response_type · state를 담는다', () => {
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn: createFakeFetch().fetchFn })

    const url = new URL(client.buildAuthorizeUrl('state-123'))

    assert.equal(url.origin + url.pathname, 'https://kauth.kakao.com/oauth/authorize')
    assert.equal(url.searchParams.get('client_id'), KAKAO_CONFIG.restApiKey)
    assert.equal(url.searchParams.get('redirect_uri'), KAKAO_CONFIG.redirectUri)
    assert.equal(url.searchParams.get('response_type'), 'code')
    assert.equal(url.searchParams.get('state'), 'state-123')
  })

  it('토큰 교환: client_secret을 포함해 form으로 POST하고 access_token을 돌려준다', async () => {
    const { fetchFn, requests } = createFakeFetch(jsonResponse(200, { access_token: 'token-abc' }))
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    const token = await client.exchangeCodeForToken('code-xyz')

    assert.equal(token, 'token-abc')
    const [req] = requests
    assert.equal(req.url, 'https://kauth.kakao.com/oauth/token')
    assert.equal(req.method, 'POST')
    const body = new URLSearchParams(String(req.body))
    assert.equal(body.get('grant_type'), 'authorization_code')
    assert.equal(body.get('client_id'), KAKAO_CONFIG.restApiKey)
    assert.equal(body.get('client_secret'), KAKAO_CONFIG.clientSecret)
    assert.equal(body.get('redirect_uri'), KAKAO_CONFIG.redirectUri)
    assert.equal(body.get('code'), 'code-xyz')
  })

  it('토큰 교환: 실패해도 재시도하지 않는다 (인가 코드는 일회용)', async () => {
    const { fetchFn, requests } = createFakeFetch(jsonResponse(500, {}))
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    await assert.rejects(client.exchangeCodeForToken('code-xyz'), KakaoApiError)

    assert.equal(requests.length, 1)
  })

  it('토큰 교환: 카카오가 4xx를 주면 KakaoApiError(token_exchange), 메시지에 code가 없다', async () => {
    const { fetchFn } = createFakeFetch(jsonResponse(400, { error: 'invalid_grant', error_code: 'KOE320' }))
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    await assert.rejects(client.exchangeCodeForToken('code-xyz'), (err) => {
      assert.ok(err instanceof KakaoApiError)
      assert.equal(err.stage, 'token_exchange')
      assert.equal(err.status, 400)
      assert.ok(!err.message.includes('code-xyz'))
      return true
    })
  })

  it('토큰 교환: 네트워크 오류도 KakaoApiError로 감싼다', async () => {
    const { fetchFn } = createFakeFetch(new TypeError('fetch failed'))
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    await assert.rejects(client.exchangeCodeForToken('code-xyz'), KakaoApiError)
  })

  it('토큰 교환: 타임아웃 → KakaoApiError, 요청에 타임아웃 신호가 붙어 있다', async () => {
    const { fetchFn, requests } = createFakeFetch(timeoutError())
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    await assert.rejects(client.exchangeCodeForToken('code-xyz'), (err) => {
      assert.ok(err instanceof KakaoApiError)
      assert.equal(err.stage, 'token_exchange')
      return true
    })
    assert.equal(requests.length, 1)
    assert.ok(requests[0].signal instanceof AbortSignal, '타임아웃이 걸리려면 fetch에 signal을 넘겨야 함')
  })

  it('사용자 조회: 타임아웃 → KakaoApiError(user_profile)', async () => {
    const { fetchFn, requests } = createFakeFetch(timeoutError())
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    await assert.rejects(client.fetchUserProfile('token-abc'), (err) => err instanceof KakaoApiError && err.stage === 'user_profile')
    assert.ok(requests[0].signal instanceof AbortSignal)
  })

  it('토큰 교환: 200이지만 access_token이 없으면 KakaoApiError', async () => {
    const { fetchFn } = createFakeFetch(jsonResponse(200, {}))
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    await assert.rejects(client.exchangeCodeForToken('code-xyz'), KakaoApiError)
  })

  it('사용자 조회: Bearer 토큰으로 요청하고 id(문자열) · 닉네임만 돌려준다', async () => {
    const kakaoBody = { id: 4000000001, kakao_account: { profile: { nickname: '홍길동' }, email: 'x@y.z' } }
    const { fetchFn, requests } = createFakeFetch(jsonResponse(200, kakaoBody))
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    const profile = await client.fetchUserProfile('token-abc')

    assert.deepEqual(profile, { id: '4000000001', nickname: '홍길동' })
    assert.equal(requests[0].url, 'https://kapi.kakao.com/v2/user/me')
    assert.equal(requests[0].headers.Authorization, 'Bearer token-abc')
  })

  it('사용자 조회: 닉네임이 없으면 nickname = null', async () => {
    const { fetchFn } = createFakeFetch(jsonResponse(200, { id: 4000000001 }))
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    assert.deepEqual(await client.fetchUserProfile('token-abc'), { id: '4000000001', nickname: null })
  })

  it('사용자 조회: 401이면 KakaoApiError(user_profile)', async () => {
    const { fetchFn } = createFakeFetch(jsonResponse(401, { code: -401 }))
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    await assert.rejects(client.fetchUserProfile('token-abc'), (err) => {
      assert.equal(err.stage, 'user_profile')
      assert.equal(err.status, 401)
      return true
    })
  })

  it('사용자 조회: id가 없으면 KakaoApiError', async () => {
    const { fetchFn } = createFakeFetch(jsonResponse(200, { kakao_account: {} }))
    const client = createKakaoClient({ config: KAKAO_CONFIG, fetchFn })

    await assert.rejects(client.fetchUserProfile('token-abc'), KakaoApiError)
  })
})
