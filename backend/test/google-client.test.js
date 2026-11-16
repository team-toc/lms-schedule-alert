import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as googleModule from '../src/google/google-client.js'
import { createGoogleClient, GoogleApiError } from '../src/google/google-client.js'
import { GOOGLE_TEST_CONFIG, TEST_GOOGLE_CLIENT_SECRET } from './helpers/test-db.js'
import {
  createFakeGoogleTokenEndpoint,
  idTokenClaims,
  makeIdToken,
  base64url,
  jsonResponse,
  tokenResponseBody,
  networkError,
  timesOut,
  DEFAULT_GOOGLE_SUB,
  DEFAULT_GOOGLE_NAME,
} from './helpers/fake-google.js'

const CODE = 'auth-code-MUST-NOT-LEAK'
const NONCE = 'nonce-0123456789abcdef0123456789abcdef'
const SUB_MAX_LENGTH = 255

function setup() {
  const endpoint = createFakeGoogleTokenEndpoint()
  const client = createGoogleClient({ config: GOOGLE_TEST_CONFIG, fetchFn: endpoint.fetchFn })
  return { endpoint, client }
}

function respondWithIdToken(endpoint, idToken) {
  endpoint.respond(CODE, () => jsonResponse(200, tokenResponseBody(idToken, CODE)))
}

// GoogleApiError(stage)인지, 메시지에 인가 코드 · 시크릿 · 토큰이 없는지 함께 본다
function assertGoogleApiError(stage, { forbidden = [] } = {}) {
  return (err) => {
    assert.ok(err instanceof GoogleApiError, `GoogleApiError여야 함: ${err?.name}`)
    assert.equal(err.stage, stage)
    for (const secret of [CODE, TEST_GOOGLE_CLIENT_SECRET, ...forbidden]) {
      assert.ok(!err.message.includes(secret), '에러 메시지에 민감 정보가 있음')
    }
    return true
  }
}

describe('Google 클라이언트: 요청 형식', () => {
  it('검증 함수는 공개하지 않는다: 모듈이 내보내는 것은 createGoogleClient · GoogleApiError뿐', () => {
    assert.deepEqual(Object.keys(googleModule).sort(), ['GoogleApiError', 'createGoogleClient'])
  })

  it('인가 URL: 공식 엔드포인트, scope는 openid profile만, refresh token · 재동의 파라미터 없음', () => {
    const { client } = setup()

    const url = new URL(client.buildAuthorizeUrl({ state: 'state-1', nonce: NONCE }))

    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      client_id: GOOGLE_TEST_CONFIG.clientId,
      redirect_uri: GOOGLE_TEST_CONFIG.redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state: 'state-1',
      nonce: NONCE,
    })
  })

  it('토큰 교환: form으로 한 번 POST하고, id_token에서 sub · name만 꺼낸다', async () => {
    const { endpoint, client } = setup()
    endpoint.issueIdToken(CODE, idTokenClaims({ nonce: NONCE }))

    const profile = await client.exchangeCodeForProfile(CODE, { nonce: NONCE })

    assert.deepEqual(profile, { id: DEFAULT_GOOGLE_SUB, nickname: DEFAULT_GOOGLE_NAME })
    assert.equal(endpoint.requests.length, 1)
    const [req] = endpoint.requests
    assert.equal(req.url, 'https://oauth2.googleapis.com/token')
    assert.equal(req.method, 'POST')
    assert.match(req.headers['Content-Type'], /^application\/x-www-form-urlencoded/)
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(req.body))), {
      code: CODE,
      client_id: GOOGLE_TEST_CONFIG.clientId,
      client_secret: GOOGLE_TEST_CONFIG.clientSecret,
      redirect_uri: GOOGLE_TEST_CONFIG.redirectUri,
      grant_type: 'authorization_code',
    })
  })

  it("iss가 'accounts.google.com'(https 없음)이어도 통과한다", async () => {
    const { endpoint, client } = setup()
    endpoint.issueIdToken(CODE, idTokenClaims({ nonce: NONCE, iss: 'accounts.google.com' }))

    assert.equal((await client.exchangeCodeForProfile(CODE, { nonce: NONCE })).id, DEFAULT_GOOGLE_SUB)
  })

  it('name이 없으면 nickname = null (기본 이름 규칙은 계정 로직이 처리)', async () => {
    const { endpoint, client } = setup()
    endpoint.issueIdToken(CODE, idTokenClaims({ nonce: NONCE, name: undefined }))

    assert.deepEqual(await client.exchangeCodeForProfile(CODE, { nonce: NONCE }), { id: DEFAULT_GOOGLE_SUB, nickname: null })
  })

  it('sub가 정확히 255자면 통과한다', async () => {
    const { endpoint, client } = setup()
    const longSub = '1'.repeat(SUB_MAX_LENGTH)
    endpoint.issueIdToken(CODE, idTokenClaims({ nonce: NONCE, sub: longSub }))

    assert.equal((await client.exchangeCodeForProfile(CODE, { nonce: NONCE })).id, longSub)
  })
})

describe('Google 클라이언트: 토큰 교환 실패 (재시도 없음)', () => {
  const cases = [
    ['400 invalid_grant', () => jsonResponse(400, { error: 'invalid_grant' })],
    ['500 서버 오류', () => jsonResponse(500, { error: 'internal_failure' })],
    ['네트워크 오류', networkError],
    ['200이지만 JSON이 아님', () => new Response('<html>oops</html>', { status: 200 })],
    ['200이지만 id_token 없음', () => jsonResponse(200, { access_token: 'fake-google-access-token-x' })],
  ]
  for (const [label, responder] of cases) {
    it(`${label} → GoogleApiError(token_exchange), 요청 1번`, async () => {
      const { endpoint, client } = setup()
      endpoint.respond(CODE, responder)

      await assert.rejects(client.exchangeCodeForProfile(CODE, { nonce: NONCE }), assertGoogleApiError('token_exchange'))
      assert.equal(endpoint.requests.length, 1)
    })
  }

  it('400이면 status와 Google error 코드만 원인으로 남긴다', async () => {
    const { endpoint, client } = setup()
    endpoint.respond(CODE, () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Bad Request' }))

    await assert.rejects(client.exchangeCodeForProfile(CODE, { nonce: NONCE }), (err) => {
      assert.equal(err.status, 400)
      assert.equal(err.googleError, 'invalid_grant')
      return true
    })
  })

  it('타임아웃 → GoogleApiError(token_exchange), 요청 1번, 요청에 타임아웃 신호가 붙어 있다', async () => {
    const { endpoint, client } = setup()
    endpoint.respond(CODE, timesOut)

    await assert.rejects(client.exchangeCodeForProfile(CODE, { nonce: NONCE }), assertGoogleApiError('token_exchange'))
    assert.equal(endpoint.requests.length, 1)
    assert.ok(endpoint.requests[0].signal instanceof AbortSignal, '타임아웃이 걸리려면 fetch에 signal을 넘겨야 함')
  })
})

describe('Google 클라이언트: id_token 검증 (서명 생략, 클레임 검사)', () => {
  const header = base64url({ alg: 'RS256', typ: 'JWT' })
  const payload = base64url(idTokenClaims({ nonce: NONCE }))
  const malformed = [
    ['두 부분', `${header}.${payload}`],
    ['네 부분', `${header}.${payload}.sig.extra`],
    ['빈 부분', `${header}..sig`],
    ['base64url이 아닌 문자', `${header}.!!!not*base64url!!!.sig`],
    // Node의 base64url 디코더는 잘못된 문자를 조용히 건너뛴다. 클레임은 유효하므로 문자 검사가 없으면 통과해 버린다.
    ['유효한 payload 중간에 * 끼움', `${header}.${payload.slice(0, 10)}*${payload.slice(10)}.sig`],
    ['유효한 payload에 패딩(=) 붙임', `${header}.${payload}==.sig`],
    ['유효한 payload 중간에 공백', `${header}.${payload.slice(0, 10)} ${payload.slice(10)}.sig`],
    ['payload가 JSON이 아님', `${header}.${base64url('not json')}.sig`],
    ['header가 JSON이 아님', `${base64url('not json')}.${payload}.sig`],
    ['payload가 객체가 아님', `${header}.${base64url('"just a string"')}.sig`],
  ]
  for (const [label, idToken] of malformed) {
    it(`형식이 깨진 id_token (${label}) → GoogleApiError(id_token)`, async () => {
      const { endpoint, client } = setup()
      respondWithIdToken(endpoint, idToken)

      await assert.rejects(
        client.exchangeCodeForProfile(CODE, { nonce: NONCE }),
        assertGoogleApiError('id_token', { forbidden: [idToken] }),
      )
    })
  }

  const nowSeconds = () => Math.floor(Date.now() / 1000)
  const invalidClaims = [
    ['iss가 다른 발급자', { iss: 'https://evil.example.com' }],
    ['iss 없음', { iss: undefined }],
    ['aud가 다른 클라이언트', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['aud가 배열(정확히 일치만 허용)', { aud: [GOOGLE_TEST_CONFIG.clientId] }],
    ['만료됨', { exp: nowSeconds() - 60 }],
    ['exp가 지금 시각(오차 허용 0초)', { exp: nowSeconds() }],
    ['exp 없음', { exp: undefined }],
    ['exp가 숫자가 아님', { exp: 'tomorrow' }],
    ['nonce 불일치', { nonce: 'other-nonce' }],
    ['nonce 없음', { nonce: undefined }],
    ['sub 없음', { sub: undefined }],
    ['sub가 문자열이 아님', { sub: 12345 }],
    ['sub가 256자', { sub: '1'.repeat(SUB_MAX_LENGTH + 1) }],
  ]
  for (const [label, overrides] of invalidClaims) {
    it(`${label} → GoogleApiError(id_token)`, async () => {
      const { endpoint, client } = setup()
      const idToken = makeIdToken(idTokenClaims({ nonce: NONCE, ...overrides }))
      respondWithIdToken(endpoint, idToken)

      await assert.rejects(
        client.exchangeCodeForProfile(CODE, { nonce: NONCE }),
        assertGoogleApiError('id_token', { forbidden: [idToken, 'fake-google-access-token'] }),
      )
    })
  }

  it('세션에 저장된 nonce가 없으면(undefined) 어떤 id_token도 통과하지 못한다', async () => {
    const { endpoint, client } = setup()
    endpoint.issueIdToken(CODE, idTokenClaims({ nonce: undefined }))

    await assert.rejects(client.exchangeCodeForProfile(CODE, { nonce: undefined }), assertGoogleApiError('id_token'))
  })
})
