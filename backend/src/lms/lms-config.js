// Canvas 연동 설정 (ADR 0008). 서버 진입점에서만 검사한다: 마이그레이션 스크립트는 Canvas 설정이 필요 없다.
// 값은 메시지에 넣지 않는다. 키 이름만 알려 준다.
import { ConfigError } from '../config.js'

const REQUIRED_KEYS = ['CANVAS_BASE_URL', 'CANVAS_TOKEN_KEY']
const TOKEN_KEY_BYTES = 32
const DEFAULT_SYNC_INTERVAL_MINUTES = 30
const MINUTE_MS = 60 * 1000

// base64 표준 문자열이 정확히 32바이트로 풀릴 때만 받는다. 다시 인코딩해 같은지 비교해 공백 · base64url · 패딩 오류도 거른다.
function parseTokenKey(value) {
  const key = Buffer.from(value, 'base64')
  if (key.length !== TOKEN_KEY_BYTES || key.toString('base64') !== value) {
    throw new ConfigError('CANVAS_TOKEN_KEY는 32바이트 값을 base64로 인코딩한 문자열이어야 함')
  }
  return key
}

// 경로 · 쿼리 · 계정 정보 없는 주소. 운영은 https만, 개발은 http도 허용. 끝의 /는 지운 출처(origin)를 돌려준다.
function parseBaseUrl(value, { isProduction }) {
  const invalid = new ConfigError('CANVAS_BASE_URL은 경로 · 쿼리 · 계정 정보 없는 https 주소여야 함 (운영이 아니면 http도 허용)')
  let url
  try {
    url = new URL(value)
  } catch {
    throw invalid
  }
  const allowedProtocols = isProduction ? ['https:'] : ['https:', 'http:']
  const hasExtras = url.username || url.password || url.search || url.hash || url.pathname !== '/'
  if (!allowedProtocols.includes(url.protocol) || hasExtras) {
    throw invalid
  }
  return url.origin
}

function parseIntervalMinutes(value) {
  if (!value) {
    return DEFAULT_SYNC_INTERVAL_MINUTES
  }
  const minutes = Number(value)
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new ConfigError('LMS_SYNC_INTERVAL_MINUTES는 1 이상의 정수여야 함')
  }
  return minutes
}

export function loadLmsConfig(env, { isProduction }) {
  const missing = REQUIRED_KEYS.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new ConfigError(`필수 환경변수가 비어 있음: ${missing.join(', ')}`)
  }
  return {
    canvasBaseUrl: parseBaseUrl(env.CANVAS_BASE_URL, { isProduction }),
    tokenKey: parseTokenKey(env.CANVAS_TOKEN_KEY),
    syncIntervalMs: parseIntervalMinutes(env.LMS_SYNC_INTERVAL_MINUTES) * MINUTE_MS,
  }
}

// 서버 진입점용. 설정 오류면 메시지 한 줄(키 이름만, 값 없음)만 출력하고 종료한다 (loadConfigOrExit와 같은 형식).
export function loadLmsConfigOrExit(env, options) {
  try {
    return loadLmsConfig(env, options)
  } catch (err) {
    if (!(err instanceof ConfigError)) {
      throw err
    }
    console.error(`설정 오류: ${err.message}`)
    process.exit(1)
  }
}
