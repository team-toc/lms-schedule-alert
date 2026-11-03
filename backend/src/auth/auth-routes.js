import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import express from 'express'
import { KakaoApiError } from '../kakao/kakao-client.js'
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../session.js'

const STATE_BYTES = 32
const KAKAO_PROVIDER = 'kakao'
// 프론트 에러 화면 경로. 쿼리에는 에러 코드만 넣는다. (ADR 0005 열린 질문)
const LOGIN_ERROR_PATH = '/login/error'
const HTTP_NO_CONTENT = 204
const HTTP_UNAUTHORIZED = 401

const LOGIN_ERROR = {
  invalidState: 'invalid_state',
  invalidRequest: 'invalid_request',
  kakaoDenied: 'kakao_login_denied',
  kakaoApiFailed: 'kakao_api_failed',
  serverError: 'server_error',
}

const UNAUTHORIZED = {
  notAuthenticated: { error: 'not_authenticated', message: '로그인이 필요합니다.' },
  alreadyLoggedOut: { error: 'already_logged_out', message: '이미 로그아웃된 상태입니다.' },
}

// Express 4는 async 핸들러의 에러를 잡지 못하므로 next로 넘긴다
const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next)

function isSameState(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') {
    return false
  }
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

// 콜백 쿼리를 검사해 실패면 에러 코드, 통과면 null. state(CSRF)를 가장 먼저 본다.
function findCallbackError({ expectedState, query }) {
  if (!isSameState(expectedState, query.state)) {
    return LOGIN_ERROR.invalidState
  }
  if (query.error) {
    return LOGIN_ERROR.kakaoDenied
  }
  if (typeof query.code !== 'string' || query.code === '') {
    return LOGIN_ERROR.invalidRequest
  }
  return null
}

// 액세스 토큰은 사용자 조회에만 쓰고 저장하지 않는다. 카카오 실패만 잡고 나머지는 올린다.
async function fetchKakaoProfile(kakaoClient, code) {
  try {
    const accessToken = await kakaoClient.exchangeCodeForToken(code)
    return { profile: await kakaoClient.fetchUserProfile(accessToken) }
  } catch (err) {
    if (!(err instanceof KakaoApiError)) {
      throw err
    }
    return { failure: { stage: err.stage, status: err.status, kakaoErrorCode: err.kakaoErrorCode } }
  }
}

function redirectToLoginError({ req, res, config }, errorCode, details = {}) {
  req.log.warn({ event: 'login_failed', reason: errorCode, ...details }, 'kakao login failed')
  const url = new URL(LOGIN_ERROR_PATH, config.frontendUrl)
  url.searchParams.set('error', errorCode)
  res.redirect(url.toString())
}

async function destroySession(req, res, cookieOptions) {
  await promisify(req.session.destroy.bind(req.session))()
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions)
}

// 세션의 사용자가 DB에 실제로 있을 때만 돌려준다. 사라진 사용자면 세션을 지운다.
async function findSessionUser(req, res, { accountService, cookieOptions }) {
  const userId = req.session?.userId
  if (!userId) {
    return null
  }
  const user = await accountService.findUserById(userId)
  if (!user) {
    req.log.info({ event: 'session_user_missing' }, 'session user no longer exists, session destroyed')
    await destroySession(req, res, cookieOptions)
  }
  return user
}

function startKakaoLogin({ kakaoClient }) {
  return (req, res) => {
    const state = randomBytes(STATE_BYTES).toString('base64url')
    req.session.oauthState = state
    res.redirect(kakaoClient.buildAuthorizeUrl(state))
  }
}

function handleKakaoCallback({ config, kakaoClient, accountService }) {
  return async (req, res) => {
    const expectedState = req.session.oauthState
    // state는 한 번만 쓴다. 성공 · 실패와 상관없이 지운다.
    delete req.session.oauthState
    const callbackError = findCallbackError({ expectedState, query: req.query })
    if (callbackError) {
      return redirectToLoginError({ req, res, config }, callbackError)
    }

    const { profile, failure } = await fetchKakaoProfile(kakaoClient, req.query.code)
    if (failure) {
      return redirectToLoginError({ req, res, config }, LOGIN_ERROR.kakaoApiFailed, failure)
    }

    const { user, isNewUser } = await accountService.loginWithIdentity({
      provider: KAKAO_PROVIDER,
      providerUserId: profile.id,
      displayName: profile.nickname,
    })
    // 세션 고정 공격 방지: 로그인 전 세션을 버리고 새 세션 ID로 발급
    await promisify(req.session.regenerate.bind(req.session))()
    req.session.userId = user.id
    req.log.info({ event: 'login_succeeded', userId: user.id, isNewUser }, 'kakao login succeeded')
    // onboarding_step별 이동 경로는 프론트와 정한 뒤 나눈다 (ADR 0005 열린 질문)
    res.redirect(config.frontendUrl)
  }
}

// 콜백은 브라우저 리다이렉트로 들어오므로 예상 못 한 에러도 JSON 대신 에러 화면으로 보낸다
function handleCallbackError({ config }) {
  return (err, req, res, next) => {
    req.log.error({ event: 'login_error', err: { name: err.name, code: err.code } }, 'kakao login error')
    if (res.headersSent) {
      return next(err)
    }
    redirectToLoginError({ req, res, config }, LOGIN_ERROR.serverError)
  }
}

function getCurrentUser(deps) {
  return async (req, res) => {
    const user = await findSessionUser(req, res, deps)
    if (!user) {
      return res.status(HTTP_UNAUTHORIZED).json(UNAUTHORIZED.notAuthenticated)
    }
    res.json({ id: user.id, displayName: user.displayName, onboardingStep: user.onboardingStep })
  }
}

function logout(deps) {
  return async (req, res) => {
    const user = await findSessionUser(req, res, deps)
    if (!user) {
      return res.status(HTTP_UNAUTHORIZED).json(UNAUTHORIZED.alreadyLoggedOut)
    }
    await destroySession(req, res, deps.cookieOptions)
    req.log.info({ event: 'logout', userId: user.id }, 'logged out')
    res.status(HTTP_NO_CONTENT).end()
  }
}

export function createAuthRouter({ config, kakaoClient, accountService }) {
  const deps = { config, kakaoClient, accountService, cookieOptions: sessionCookieOptions(config) }
  const router = express.Router()
  router.get('/kakao', startKakaoLogin(deps))
  router.get('/kakao/callback', asyncRoute(handleKakaoCallback(deps)))
  router.use('/kakao/callback', handleCallbackError(deps))
  router.get('/me', asyncRoute(getCurrentUser(deps)))
  router.post('/logout', asyncRoute(logout(deps)))
  return router
}
