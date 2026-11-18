// 브라우저 푸시 설정 (ADR 0012): VAPID 키 쌍과 연락처. 서버 시작 때 검사하고, 틀리면 키 이름만 알려 준다(값은 넣지 않음).
// - VAPID_PUBLIC_KEY: P-256 공개키 65바이트(0x04 비압축) base64url — 프론트가 구독할 때 쓰는 값(공개)
// - VAPID_PRIVATE_KEY: P-256 개인키 32바이트 base64url — 비밀값. 이 개인키에서 계산한 공개키가 VAPID_PUBLIC_KEY와 같아야 한다
//   (짝이 안 맞으면 모든 푸시가 403이 된다)
// - VAPID_SUBJECT: 푸시 서비스가 연락할 주소, mailto: 또는 https: (RFC 8292)
import { createECDH } from 'node:crypto'
import { ConfigError } from '../config.js'

const REQUIRED_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']
const BASE64URL = /^[A-Za-z0-9_-]+$/
const PUBLIC_KEY_BYTES = 65
const PRIVATE_KEY_BYTES = 32
const UNCOMPRESSED_POINT = 0x04
const MAILTO = /^mailto:[^\s@]+@[^\s@]+$/

// 다시 인코딩해 같은 문자열일 때만(패딩 · 표준 base64 · 다른 표기 거부)
function decodeBase64url(value) {
  if (!BASE64URL.test(value)) {
    return null
  }
  const bytes = Buffer.from(value, 'base64url')
  return bytes.toString('base64url') === value ? bytes : null
}

function parsePublicKey(value) {
  const bytes = decodeBase64url(value)
  if (!bytes || bytes.length !== PUBLIC_KEY_BYTES || bytes[0] !== UNCOMPRESSED_POINT) {
    throw new ConfigError('VAPID_PUBLIC_KEY는 P-256 공개키(65바이트, 0x04로 시작)를 base64url로 인코딩한 문자열이어야 함')
  }
  return bytes
}

// 개인키에서 공개키를 계산해 짝을 확인한다
function checkPrivateKey(value, publicKey) {
  const bytes = decodeBase64url(value)
  const invalid = new ConfigError('VAPID_PRIVATE_KEY는 P-256 개인키(32바이트)를 base64url로 인코딩한 문자열이어야 함')
  if (!bytes || bytes.length !== PRIVATE_KEY_BYTES) {
    throw invalid
  }
  const ecdh = createECDH('prime256v1')
  try {
    ecdh.setPrivateKey(bytes)
  } catch {
    throw invalid
  }
  if (!ecdh.getPublicKey().equals(publicKey)) {
    throw new ConfigError('VAPID_PRIVATE_KEY가 VAPID_PUBLIC_KEY와 짝이 아님 (같이 만든 키 쌍이어야 함)')
  }
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname !== ''
  } catch {
    return false
  }
}

function checkSubject(value) {
  if (!MAILTO.test(value) && !isHttpsUrl(value)) {
    throw new ConfigError('VAPID_SUBJECT는 mailto:주소 또는 https:// 주소여야 함')
  }
}

export function loadPushConfig(env) {
  const missing = REQUIRED_KEYS.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new ConfigError(`필수 환경변수가 비어 있음: ${missing.join(', ')}`)
  }
  const publicKey = parsePublicKey(env.VAPID_PUBLIC_KEY)
  checkPrivateKey(env.VAPID_PRIVATE_KEY, publicKey)
  checkSubject(env.VAPID_SUBJECT)
  return { vapidPublicKey: env.VAPID_PUBLIC_KEY, vapidPrivateKey: env.VAPID_PRIVATE_KEY, vapidSubject: env.VAPID_SUBJECT }
}

// 서버 진입점용. 설정 오류면 메시지 한 줄(키 이름만, 값 없음)만 출력하고 종료한다 (Canvas 설정과 같은 형식)
export function loadPushConfigOrExit(env) {
  try {
    return loadPushConfig(env)
  } catch (err) {
    if (!(err instanceof ConfigError)) {
      throw err
    }
    console.error(`설정 오류: ${err.message}`)
    process.exit(1)
  }
}
