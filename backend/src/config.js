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
]
const DEFAULT_PORT = 4000
const MIN_SESSION_SECRET_LENGTH = 32

export class ConfigError extends Error {}

// 값은 메시지에 넣지 않는다. 빠진 키 이름만 알려 준다.
export function loadConfig(env = process.env) {
  const missing = REQUIRED_KEYS.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new ConfigError(`필수 환경변수가 비어 있음: ${missing.join(', ')}`)
  }
  if (env.SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigError(`SESSION_SECRET은 ${MIN_SESSION_SECRET_LENGTH}자 이상이어야 함`)
  }

  const isProduction = env.NODE_ENV === 'production'
  return {
    port: Number(env.PORT) || DEFAULT_PORT,
    isProduction,
    logLevel: env.LOG_LEVEL || 'info',
    frontendUrl: env.FRONTEND_URL,
    sessionSecret: env.SESSION_SECRET,
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
  }
}
