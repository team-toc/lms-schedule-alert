const REQUIRED_KEYS = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'SESSION_SECRET',
  'FRONTEND_URL',
  'KAKAO_REST_API_KEY',
  // 카카오 콘솔에서 기본 활성화. 없으면 실제 토큰 교환이 실패한다
  'KAKAO_CLIENT_SECRET',
  'KAKAO_REDIRECT_URI',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
]
const DEFAULT_PORT = 4000
const MIN_SESSION_SECRET_LENGTH = 32
const DEFAULT_SESSION_TTL_DAYS = 7
// 이메일 로그인 실패 제한: LOGIN_LOCK_MINUTES는 "실패를 세는 기간"이자 "잠금 시간" (ADR 0007)
const DEFAULT_LOGIN_MAX_FAILURES = 5
const DEFAULT_LOGIN_LOCK_MINUTES = 15
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const BOOLEAN_VALUES = { true: true, false: false, '': false }

export class ConfigError extends Error {}

function parseBoolean(env, key) {
  const value = BOOLEAN_VALUES[env[key] ?? '']
  if (value === undefined) {
    throw new ConfigError(`${key}는 true 또는 false여야 함`)
  }
  return value
}

function parsePositiveInteger(env, key, defaultValue) {
  if (!env[key]) {
    return defaultValue
  }
  const value = Number(env[key])
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key}는 1 이상의 정수여야 함`)
  }
  return value
}

// 값은 메시지에 넣지 않는다. 빠진 키 이름만 알려 준다.
export function loadConfig(env = process.env) {
  const missing = REQUIRED_KEYS.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new ConfigError(`필수 환경변수가 비어 있음: ${missing.join(', ')}`)
  }
  if (env.SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigError(`SESSION_SECRET은 ${MIN_SESSION_SECRET_LENGTH}자 이상이어야 함`)
  }

  return {
    port: Number(env.PORT) || DEFAULT_PORT,
    isProduction: env.NODE_ENV === 'production',
    // nginx 같은 리버스 프록시 뒤일 때만 켠다 (X-Forwarded-Proto로 https 판단)
    trustProxy: parseBoolean(env, 'TRUST_PROXY'),
    logLevel: env.LOG_LEVEL || 'info',
    frontendUrl: env.FRONTEND_URL,
    session: {
      secret: env.SESSION_SECRET,
      ttlMs: parsePositiveInteger(env, 'SESSION_TTL_DAYS', DEFAULT_SESSION_TTL_DAYS) * DAY_MS,
    },
    loginThrottle: {
      maxFailures: parsePositiveInteger(env, 'LOGIN_MAX_FAILURES', DEFAULT_LOGIN_MAX_FAILURES),
      lockMs: parsePositiveInteger(env, 'LOGIN_LOCK_MINUTES', DEFAULT_LOGIN_LOCK_MINUTES) * MINUTE_MS,
    },
    db: {
      host: env.DB_HOST,
      port: Number(env.DB_PORT),
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
    },
    kakao: {
      restApiKey: env.KAKAO_REST_API_KEY,
      clientSecret: env.KAKAO_CLIENT_SECRET,
      redirectUri: env.KAKAO_REDIRECT_URI,
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI,
    },
  }
}

// 실행 진입점(서버 · 마이그레이션)용. 설정 오류면 메시지 한 줄(키 이름만, 값 없음)만 출력하고 종료한다.
export function loadConfigOrExit(env = process.env) {
  try {
    return loadConfig(env)
  } catch (err) {
    if (!(err instanceof ConfigError)) {
      throw err
    }
    console.error(`설정 오류: ${err.message}`)
    process.exit(1)
  }
}
