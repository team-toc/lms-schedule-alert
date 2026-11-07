import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { asyncRoute } from './async-route.js'

const RANDOM_TOKEN_BYTES = 32
// 프론트 에러 화면 경로. 쿼리에는 에러 코드만 넣는다. (ADR 0005 열린 질문)
const LOGIN_ERROR_PATH = '/login/error'

// 제공자와 상관없는 콜백 에러 코드. 제공자별 코드(동의 거부 · API 실패)는 provider.errors에 있다.
const COMMON_LOGIN_ERROR = {
  invalidState: 'invalid_state',
  invalidRequest: 'invalid_request',
  serverError: 'server_error',
}

function randomToken() {
  return randomBytes(RANDOM_TOKEN_BYTES).toString('base64url')
}

function isSameState(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') {
    return false
  }
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

function saveLoginAttempt(session, provider, attempt) {
  session[provider.sessionKey] = provider.usesNonce ? attempt : attempt.state
}

// 로그인 시도(state · nonce)는 한 번만 쓴다. 꺼내자마자 성공 · 실패와 상관없이 지운다.
function takeLoginAttempt(session, provider) {
  const saved = session[provider.sessionKey]
  delete session[provider.sessionKey]
  if (provider.usesNonce) {
    return { state: saved?.state, nonce: saved?.nonce }
  }
  return { state: saved, nonce: undefined }
}

// 콜백 쿼리를 검사해 실패면 에러 코드, 통과면 null. state(CSRF)를 가장 먼저 본다.
function findCallbackError({ provider, expectedState, query }) {
  if (!isSameState(expectedState, query.state)) {
    return COMMON_LOGIN_ERROR.invalidState
  }
  if (query.error) {
    return provider.errors.denied
  }
  if (typeof query.code !== 'string' || query.code === '') {
    return COMMON_LOGIN_ERROR.invalidRequest
  }
  return null
}

// 제공자 API 실패만 잡고 나머지는 올린다
async function fetchProfileOrFailure(provider, { code, nonce }) {
  try {
    return { profile: await provider.fetchProfile({ code, nonce }) }
  } catch (err) {
    if (!provider.isApiError(err)) {
      throw err
    }
    return { failure: provider.describeFailure(err) }
  }
}

function redirectToLoginError({ req, res, config, provider }, errorCode, details = {}) {
  req.log.warn(
    { event: 'login_failed', provider: provider.name, reason: errorCode, ...details },
    `${provider.name} login failed`,
  )
  const url = new URL(LOGIN_ERROR_PATH, config.frontendUrl)
  url.searchParams.set('error', errorCode)
  res.redirect(url.toString())
}

function startLogin({ provider }) {
  return (req, res) => {
    const attempt = { state: randomToken(), nonce: provider.usesNonce ? randomToken() : undefined }
    saveLoginAttempt(req.session, provider, attempt)
    res.redirect(provider.buildAuthorizeUrl(attempt))
  }
}

function handleCallback({ config, provider, accountService }) {
  return async (req, res) => {
    const reply = { req, res, config, provider }
    const attempt = takeLoginAttempt(req.session, provider)
    const callbackError = findCallbackError({ provider, expectedState: attempt.state, query: req.query })
    if (callbackError) {
      return redirectToLoginError(reply, callbackError)
    }

    const { profile, failure } = await fetchProfileOrFailure(provider, { code: req.query.code, nonce: attempt.nonce })
    if (failure) {
      return redirectToLoginError(reply, provider.errors.apiFailed, failure)
    }

    const { user, isNewUser } = await accountService.loginWithIdentity({
      provider: provider.name,
      providerUserId: profile.id,
      displayName: profile.nickname,
    })
    // 세션 고정 공격 방지: 로그인 전 세션을 버리고 새 세션 ID로 발급
    await promisify(req.session.regenerate.bind(req.session))()
    req.session.userId = user.id
    req.log.info({ event: 'login_succeeded', provider: provider.name, userId: user.id, isNewUser }, `${provider.name} login succeeded`)
    // onboarding_step별 이동 경로는 프론트와 정한 뒤 나눈다 (ADR 0005 열린 질문)
    res.redirect(config.frontendUrl)
  }
}

// 콜백은 브라우저 리다이렉트로 들어오므로 예상 못 한 에러도 JSON 대신 에러 화면으로 보낸다
function handleCallbackError({ config, provider }) {
  return (err, req, res, next) => {
    req.log.error(
      { event: 'login_error', provider: provider.name, err: { name: err.name, code: err.code } },
      `${provider.name} login error`,
    )
    if (res.headersSent) {
      return next(err)
    }
    redirectToLoginError({ req, res, config, provider }, COMMON_LOGIN_ERROR.serverError)
  }
}

// /<제공자>, /<제공자>/callback 라우트를 단다
export function mountOAuthProvider(router, { config, provider, accountService }) {
  const deps = { config, provider, accountService }
  router.get(`/${provider.name}`, startLogin(deps))
  router.get(`/${provider.name}/callback`, asyncRoute(handleCallback(deps)))
  router.use(`/${provider.name}/callback`, handleCallbackError(deps))
}
