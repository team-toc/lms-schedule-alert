// 비밀 문자열 암호화 · 복호화 경계 레이어 (AES-256-GCM, ADR 0008 · 0010). Canvas 토큰과 iCloud 공개 링크에 쓴다.
// 저장 형식: 'v1:' + base64(IV 12바이트 ‖ 인증 태그 16바이트 ‖ 암호문). AAD에 용도와 user_id를 넣어
// 다른 사용자 행으로 옮기거나 다른 용도(토큰 ↔ 링크)로 바꿔 끼운 암호문은 풀리지 않는다.
// 토큰 · 암호문은 에러 메시지에 넣지 않는다.
import { createCipheriv, createDecipheriv, randomBytes as cryptoRandomBytes } from 'node:crypto'

const VERSION_PREFIX = 'v1:'
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

export class TokenDecryptError extends Error {
  // reason: 'unsupported_format' | 'malformed' | 'authentication_failed'
  constructor(reason) {
    super(`Canvas 토큰 복호화 실패: ${reason}`)
    this.name = 'TokenDecryptError'
    this.reason = reason
  }
}

// 용도별 AAD. Canvas 토큰은 refactor 전과 바이트 단위로 같아야 한다(이미 저장된 암호문이 그대로 풀리게)
export const CIPHER_CONTEXTS = Object.freeze({
  lmsToken: (userId) => `lms_tokens.user_id:${userId}`,
  icloudLink: (userId) => `calendar_link:icloud:${userId}`,
})

function additionalData(context, userId) {
  return Buffer.from(context(userId), 'utf8')
}

function unpack(tokenEnc) {
  if (typeof tokenEnc !== 'string' || !tokenEnc.startsWith(VERSION_PREFIX)) {
    throw new TokenDecryptError('unsupported_format')
  }
  const encoded = tokenEnc.slice(VERSION_PREFIX.length)
  if (!BASE64_PATTERN.test(encoded)) {
    throw new TokenDecryptError('malformed')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length <= IV_BYTES + TAG_BYTES) {
    throw new TokenDecryptError('malformed')
  }
  return {
    iv: bytes.subarray(0, IV_BYTES),
    tag: bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    ciphertext: bytes.subarray(IV_BYTES + TAG_BYTES),
  }
}

// context: CIPHER_CONTEXTS 중 하나(기본 Canvas 토큰)
export function createTokenCipher({ key, context = CIPHER_CONTEXTS.lmsToken, randomBytes = cryptoRandomBytes } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError('토큰 암호화 키는 32바이트 Buffer여야 함')
  }

  function encrypt(token, { userId }) {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(additionalData(context, userId))
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    return VERSION_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
  }

  // 키가 다르거나 · 다른 사용자 행이거나 · 한 바이트라도 바뀌면 인증 태그 검사에서 실패한다
  function decrypt(tokenEnc, { userId }) {
    const { iv, tag, ciphertext } = unpack(tokenEnc)
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(additionalData(context, userId))
    decipher.setAuthTag(tag)
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
      throw new TokenDecryptError('authentication_failed')
    }
  }

  return { encrypt, decrypt }
}
