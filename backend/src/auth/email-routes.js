import { asyncRoute } from './async-route.js'
import { startUserSession, toUserResponse } from './session-login.js'
import { validateSignupInput, validateLoginInput, maskEmail, VALIDATION_MESSAGES } from '../email/email-input.js'
import { EmailAlreadyRegisteredError } from '../accounts/email-account-service.js'

// 이메일 가입 · 로그인 (ADR 0007). JSON 요청 · 응답, 리다이렉트 없음.
const EMAIL_PROVIDER = 'email'
const HTTP_CREATED = 201
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_CONFLICT = 409
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415
const HTTP_TOO_MANY_REQUESTS = 429

const ERROR_BODY = {
  unsupportedMediaType: { error: 'unsupported_media_type', message: 'Content-Type은 application/json이어야 합니다.' },
  emailAlreadyRegistered: { error: 'email_already_registered', message: '이미 가입된 이메일입니다.' },
  invalidCredentials: { error: 'invalid_credentials', message: '이메일 또는 비밀번호가 올바르지 않습니다.' },
  tooManyAttempts: { error: 'too_many_attempts', message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
}

// 폼 POST(다른 사이트에서 보낸 요청 포함)를 막기 위해 JSON만 받는다
function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(HTTP_UNSUPPORTED_MEDIA_TYPE).json(ERROR_BODY.unsupportedMediaType)
  }
  next()
}

function sendValidationError(res, { code, field }) {
  res.status(HTTP_BAD_REQUEST).json({ error: code, field, message: VALIDATION_MESSAGES[code] })
}

// 이메일은 마스킹해서만 남긴다. 비밀번호 · 해시 · 요청 본문은 남기지 않는다.
function logAuthEvent(req, { level = 'info', event, email, ...details }) {
  req.log[level]({ event, provider: EMAIL_PROVIDER, email: maskEmail(email), ...details }, `email ${event}`)
}

function handleSignup({ emailAccountService }) {
  return async (req, res) => {
    const { value, error } = validateSignupInput(req.body)
    if (error) {
      return sendValidationError(res, error)
    }
    let user
    try {
      user = await emailAccountService.signup(value)
    } catch (err) {
      if (!(err instanceof EmailAlreadyRegisteredError)) {
        throw err
      }
      logAuthEvent(req, { event: 'signup_rejected', email: value.email, reason: 'email_already_registered' })
      return res.status(HTTP_CONFLICT).json(ERROR_BODY.emailAlreadyRegistered)
    }
    await startUserSession(req, user)
    logAuthEvent(req, { event: 'signup_succeeded', email: value.email, userId: user.id })
    res.status(HTTP_CREATED).json(toUserResponse(user))
  }
}

// 순서: 입력 검증 → 실패 횟수 제한 → 비밀번호 검증. 잠겨 있으면 해시 비교 없이 바로 429.
function handleLogin({ emailAccountService, loginThrottle }) {
  return async (req, res) => {
    const { value, error } = validateLoginInput(req.body)
    if (error) {
      return sendValidationError(res, error)
    }
    const attempt = { email: value.email, ip: req.ip }
    const gate = loginThrottle.check(attempt)
    if (!gate.allowed) {
      logAuthEvent(req, { level: 'warn', event: 'login_failed', email: value.email, reason: 'too_many_attempts' })
      res.set('Retry-After', String(gate.retryAfterSeconds))
      return res.status(HTTP_TOO_MANY_REQUESTS).json(ERROR_BODY.tooManyAttempts)
    }
    const user = await emailAccountService.login(value)
    if (!user) {
      loginThrottle.recordFailure(attempt)
      logAuthEvent(req, { level: 'warn', event: 'login_failed', email: value.email, reason: 'invalid_credentials' })
      return res.status(HTTP_UNAUTHORIZED).json(ERROR_BODY.invalidCredentials)
    }
    loginThrottle.reset(attempt)
    await startUserSession(req, user)
    logAuthEvent(req, { event: 'login_succeeded', email: value.email, userId: user.id })
    res.json(toUserResponse(user))
  }
}

export function mountEmailRoutes(router, { emailAccountService, loginThrottle }) {
  const deps = { emailAccountService, loginThrottle }
  router.post('/email/signup', requireJson, asyncRoute(handleSignup(deps)))
  router.post('/email/login', requireJson, asyncRoute(handleLogin(deps)))
}
