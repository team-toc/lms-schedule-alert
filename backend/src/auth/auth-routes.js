import { promisify } from 'node:util'
import express from 'express'
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../session.js'
import { asyncRoute } from './async-route.js'
import { mountOAuthProvider } from './oauth-flow.js'
import { createKakaoProvider, createGoogleProvider } from './oauth-providers.js'

const HTTP_NO_CONTENT = 204
const HTTP_UNAUTHORIZED = 401

const UNAUTHORIZED = {
  notAuthenticated: { error: 'not_authenticated', message: '로그인이 필요합니다.' },
  alreadyLoggedOut: { error: 'already_logged_out', message: '이미 로그아웃된 상태입니다.' },
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

export function createAuthRouter({ config, kakaoClient, googleClient, accountService }) {
  const deps = { config, accountService, cookieOptions: sessionCookieOptions(config) }
  const router = express.Router()
  mountOAuthProvider(router, { config, accountService, provider: createKakaoProvider(kakaoClient) })
  mountOAuthProvider(router, { config, accountService, provider: createGoogleProvider(googleClient) })
  router.get('/me', asyncRoute(getCurrentUser(deps)))
  router.post('/logout', asyncRoute(logout(deps)))
  return router
}
