import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPasswordHasher, ARGON2_PARAMS } from '../src/email/password-hasher.js'

const PASSWORD = 'correct horse battery staple'
// $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
const ARGON2ID_PHC = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/

describe('비밀번호 해시 (경계 레이어)', () => {
  const hasher = createPasswordHasher()

  it('파라미터: argon2id, m=19456 KiB, t=2, p=1 (ADR 0007)', () => {
    assert.deepEqual(ARGON2_PARAMS, { type: 'argon2id', memoryCost: 19456, timeCost: 2, parallelism: 1 })
  })

  it('9. 해시는 argon2id 표준 문자열이고 원문을 포함하지 않는다', async () => {
    const passwordHash = await hasher.hash(PASSWORD)

    assert.match(passwordHash, ARGON2ID_PHC)
    assert.ok(!passwordHash.includes(PASSWORD))
    assert.ok(passwordHash.length <= 255, 'password_hash VARCHAR(255)에 들어가야 함')
  })

  it('같은 비밀번호도 매번 다른 솔트로 다른 해시가 된다', async () => {
    assert.notEqual(await hasher.hash(PASSWORD), await hasher.hash(PASSWORD))
  })

  it('verify: 맞는 비밀번호 true, 틀린 비밀번호 false', async () => {
    const passwordHash = await hasher.hash(PASSWORD)

    assert.equal(await hasher.verify(passwordHash, PASSWORD), true)
    assert.equal(await hasher.verify(passwordHash, `${PASSWORD}!`), false)
    assert.equal(await hasher.verify(passwordHash, PASSWORD.toUpperCase()), false)
  })

  it('verify: 128자 비밀번호의 마지막 글자만 달라도 false (bcrypt처럼 잘리지 않음)', async () => {
    const long = '가'.repeat(127)
    const passwordHash = await hasher.hash(`${long}A`)

    assert.equal(await hasher.verify(passwordHash, `${long}B`), false)
  })

  it('verify: 해시 문자열이 깨져 있으면 예외 대신 false', async () => {
    assert.equal(await hasher.verify('not-a-hash', PASSWORD), false)
  })
})
