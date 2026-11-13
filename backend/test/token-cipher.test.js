import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createTokenCipher, TokenDecryptError } from '../src/lms/token-cipher.js'

const KEY = Buffer.alloc(32, 9)
const TOKEN = '7~CipherTest0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV'
const USER = { userId: 1 }
const CIPHERTEXT_COLUMN_LENGTH = 512

function assertDecryptFails(cipher, tokenEnc, options = USER) {
  assert.throws(
    () => cipher.decrypt(tokenEnc, options),
    (err) => {
      assert.ok(err instanceof TokenDecryptError, `TokenDecryptError여야 함: ${err?.name}`)
      assert.ok(!err.message.includes(TOKEN), '에러에 토큰 원문 금지')
      if (typeof tokenEnc === 'string' && tokenEnc.length > 8) {
        assert.ok(!err.message.includes(tokenEnc), '에러에 암호문 금지')
      }
      return true
    },
  )
}

describe('Canvas 토큰 암호화 (AES-256-GCM)', () => {
  const cipher = createTokenCipher({ key: KEY })

  it('암호화 → v1: 형식, 원문 · base64 원문 · 해시를 포함하지 않고 같은 사용자로 복호화된다', () => {
    const tokenEnc = cipher.encrypt(TOKEN, USER)

    assert.match(tokenEnc, /^v1:[A-Za-z0-9+/]+=*$/)
    for (const leak of [TOKEN, Buffer.from(TOKEN).toString('base64'), createHash('sha256').update(TOKEN).digest('hex')]) {
      assert.ok(!tokenEnc.includes(leak))
    }
    assert.equal(cipher.decrypt(tokenEnc, USER), TOKEN)
  })

  it('같은 토큰도 매번 다른 암호문 (IV는 매번 12바이트 난수)', () => {
    const sizes = []
    const recording = createTokenCipher({
      key: KEY,
      randomBytes: (size) => {
        sizes.push(size)
        return Buffer.alloc(size, sizes.length)
      },
    })

    assert.notEqual(recording.encrypt(TOKEN, USER), recording.encrypt(TOKEN, USER))
    assert.deepEqual(sizes, [12, 12])
    assert.notEqual(cipher.encrypt(TOKEN, USER), cipher.encrypt(TOKEN, USER))
  })

  it('최대 길이(200자) 토큰도 lms_tokens.token_enc(512자)에 들어간다', () => {
    const longest = 'a'.repeat(200)
    const tokenEnc = cipher.encrypt(longest, USER)

    assert.ok(tokenEnc.startsWith('v1:'))
    assert.ok(tokenEnc.length <= CIPHERTEXT_COLUMN_LENGTH)
    assert.equal(cipher.decrypt(tokenEnc, USER), longest)
  })

  it('다른 사용자 id로는 복호화되지 않는다 (AAD = user_id, 행을 옮겨 붙여도 못 씀)', () => {
    assertDecryptFails(cipher, cipher.encrypt(TOKEN, USER), { userId: 2 })
  })

  it('다른 키로는 복호화되지 않는다', () => {
    assertDecryptFails(createTokenCipher({ key: Buffer.alloc(32, 8) }), cipher.encrypt(TOKEN, USER))
  })

  it('암호문을 한 글자라도 바꾸면 복호화되지 않는다 (인증 태그)', () => {
    const tokenEnc = cipher.encrypt(TOKEN, USER)
    const middle = Math.floor(tokenEnc.length / 2)
    const flipped = tokenEnc[middle] === 'A' ? 'B' : 'A'

    assertDecryptFails(cipher, tokenEnc.slice(0, middle) + flipped + tokenEnc.slice(middle + 1))
  })

  it('형식이 틀린 값은 TokenDecryptError (빈 값 · 다른 버전 · base64 아님 · 너무 짧음 · 문자열 아님)', () => {
    const valid = cipher.encrypt(TOKEN, USER)
    for (const bad of ['', 'v1:', `v2:${valid.slice(3)}`, 'v1:!!!!', 'v1:AAAA', valid.slice(0, 20), null, 42]) {
      assertDecryptFails(cipher, bad)
    }
  })

  it('키가 32바이트 Buffer가 아니면 만들 수 없다', () => {
    for (const key of [Buffer.alloc(16), Buffer.alloc(33), 'a'.repeat(32), undefined]) {
      assert.throws(() => createTokenCipher({ key }), /32바이트/)
    }
  })
})
