import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { createTokenCipher, TokenDecryptError, CIPHER_CONTEXTS } from '../src/lms/token-cipher.js'

const KEY = Buffer.alloc(32, 7)
const IV = Buffer.alloc(12, 3)
const USER_ID = 42
const TOKEN = '7~ContextTest0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP'
const LINK = 'https://p52-caldav.icloud.com/published/2/CONTEXTtestTOKEN0000'

// refactor 전 방식을 그대로 손으로 재현: AAD = 'lms_tokens.user_id:<id>'(UTF-8), 'v1:' + base64(IV ‖ 태그 ‖ 암호문)
function encryptTheOldWay(plaintext, userId) {
  const cipher = createCipheriv('aes-256-gcm', KEY, IV)
  cipher.setAAD(Buffer.from(`lms_tokens.user_id:${userId}`, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `v1:${Buffer.concat([IV, cipher.getAuthTag(), body]).toString('base64')}`
}

const fixedIv = () => Buffer.from(IV)

// 암호화 용도(AAD) 분리 (ADR 0010 리뷰 결정 1): Canvas 토큰은 바이트 그대로, iCloud 링크는 'calendar_link:icloud:<user_id>'
describe('토큰 암호화: 용도(context)별 AAD', () => {
  it('refactor 전 방식으로 만든 Canvas 토큰 암호문이 그대로 풀린다 (기본 용도 = Canvas)', () => {
    const stored = encryptTheOldWay(TOKEN, USER_ID)

    assert.equal(createTokenCipher({ key: KEY }).decrypt(stored, { userId: USER_ID }), TOKEN)
    assert.equal(createTokenCipher({ key: KEY, context: CIPHER_CONTEXTS.lmsToken }).decrypt(stored, { userId: USER_ID }), TOKEN)
  })

  it('Canvas 용도의 암호문은 바이트 단위로 refactor 전과 같다 (같은 키 · IV)', () => {
    const cipher = createTokenCipher({ key: KEY, randomBytes: fixedIv })

    assert.equal(cipher.encrypt(TOKEN, { userId: USER_ID }), encryptTheOldWay(TOKEN, USER_ID))
  })

  it('iCloud 링크 용도의 AAD는 calendar_link:icloud:<user_id>', () => {
    const link = createTokenCipher({ key: KEY, context: CIPHER_CONTEXTS.icloudLink, randomBytes: fixedIv })
    const stored = link.encrypt(LINK, { userId: USER_ID })
    const raw = Buffer.from(stored.slice(3), 'base64')

    const decipher = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12))
    decipher.setAAD(Buffer.from(`calendar_link:icloud:${USER_ID}`, 'utf8'))
    decipher.setAuthTag(raw.subarray(12, 28))
    assert.equal(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'), LINK)
  })

  it('Canvas 암호문을 링크 용도로 풀면 실패, 링크 암호문을 Canvas 용도로 풀어도 실패 (같은 키 · 같은 사용자)', () => {
    const canvas = createTokenCipher({ key: KEY })
    const link = createTokenCipher({ key: KEY, context: CIPHER_CONTEXTS.icloudLink })
    const tokenEnc = canvas.encrypt(TOKEN, { userId: USER_ID })
    const linkEnc = link.encrypt(LINK, { userId: USER_ID })

    assert.throws(() => link.decrypt(tokenEnc, { userId: USER_ID }), TokenDecryptError)
    assert.throws(() => canvas.decrypt(linkEnc, { userId: USER_ID }), TokenDecryptError)
    assert.equal(link.decrypt(linkEnc, { userId: USER_ID }), LINK)
  })

  it('링크 용도에서도 다른 사용자 행으로 옮긴 암호문은 풀리지 않는다', () => {
    const link = createTokenCipher({ key: KEY, context: CIPHER_CONTEXTS.icloudLink })

    assert.throws(() => link.decrypt(link.encrypt(LINK, { userId: USER_ID }), { userId: USER_ID + 1 }), TokenDecryptError)
  })
})

