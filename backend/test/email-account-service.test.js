import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEmailAccountService,
  createDummyPasswordHash,
  EmailAlreadyRegisteredError,
} from '../src/accounts/email-account-service.js'
import { DuplicateIdentityError } from '../src/accounts/user-repository.js'
import { DEFAULT_DISPLAY_NAME } from '../src/accounts/account-service.js'
import { createPasswordHasher } from '../src/email/password-hasher.js'

const EMAIL = 'user@example.com'
const PASSWORD = 'correct horse battery staple'
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlzYWx0$ZHVtbXloYXNo'

// 해시를 계산하지 않는 가짜 해시 모듈: "hashed:<원문>" 형식, 호출을 기록한다
function createFakeHasher() {
  const calls = { hash: [], verify: [] }
  return {
    calls,
    async hash(password) {
      calls.hash.push(password)
      return `hashed:${password}`
    },
    async verify(passwordHash, password) {
      calls.verify.push(passwordHash)
      return passwordHash === `hashed:${password}`
    },
  }
}

// DB 없이 이메일 계정만 다루는 메모리 저장소. failCreateWith: 생성 시 이 에러를 던진다.
function createMemoryRepository({ failCreateWith = null } = {}) {
  const accounts = new Map()
  return {
    accounts,
    async createUserWithPassword({ email, displayName, passwordHash }) {
      if (failCreateWith) {
        throw failCreateWith
      }
      if (accounts.has(email)) {
        throw new DuplicateIdentityError()
      }
      const user = { id: accounts.size + 1, displayName, onboardingStep: 'lms_token' }
      accounts.set(email, { user, passwordHash })
      return user
    },
    async findEmailCredential(email) {
      return accounts.get(email) ?? null
    },
  }
}

function setup(repoOptions) {
  const hasher = createFakeHasher()
  const repo = createMemoryRepository(repoOptions)
  const service = createEmailAccountService({ userRepository: repo, passwordHasher: hasher, dummyPasswordHash: DUMMY_HASH })
  return { hasher, repo, service }
}

describe('이메일 계정 로직 (가입)', () => {
  it('비밀번호는 해시해서 저장하고, 표시 이름은 소셜과 같은 규칙으로 정리한다', async () => {
    const { hasher, repo, service } = setup()

    const user = await service.signup({ email: EMAIL, password: PASSWORD, displayName: '  홍길동  ' })

    assert.deepEqual(user, { id: 1, displayName: '홍길동', onboardingStep: 'lms_token' })
    assert.equal(repo.accounts.get(EMAIL).passwordHash, `hashed:${PASSWORD}`)
    assert.deepEqual(hasher.calls.hash, [PASSWORD])
  })

  it('표시 이름이 없으면 "사용자"', async () => {
    const { service } = setup()

    assert.equal((await service.signup({ email: EMAIL, password: PASSWORD, displayName: null })).displayName, DEFAULT_DISPLAY_NAME)
  })

  it('이미 있는 이메일 → EmailAlreadyRegisteredError (기존 계정으로 로그인시키지 않음)', async () => {
    const { service } = setup()
    await service.signup({ email: EMAIL, password: PASSWORD, displayName: null })

    await assert.rejects(service.signup({ email: EMAIL, password: 'other password', displayName: null }), EmailAlreadyRegisteredError)
  })

  it('중복 키가 아닌 저장소 에러는 그대로 올린다', async () => {
    const dbError = new Error('Lost connection')
    const { service } = setup({ failCreateWith: dbError })

    await assert.rejects(service.signup({ email: EMAIL, password: PASSWORD, displayName: null }), (err) => err === dbError)
  })
})

describe('이메일 계정 로직 (로그인)', () => {
  it('맞는 비밀번호 → 사용자, 해시 비교 1번', async () => {
    const { hasher, service } = setup()
    const created = await service.signup({ email: EMAIL, password: PASSWORD, displayName: null })

    assert.deepEqual(await service.login({ email: EMAIL, password: PASSWORD }), created)
    assert.deepEqual(hasher.calls.verify, [`hashed:${PASSWORD}`])
  })

  it('틀린 비밀번호 → null, 해시 비교 1번', async () => {
    const { hasher, service } = setup()
    await service.signup({ email: EMAIL, password: PASSWORD, displayName: null })

    assert.equal(await service.login({ email: EMAIL, password: 'wrong password' }), null)
    assert.equal(hasher.calls.verify.length, 1)
  })

  it('없는 이메일 → null, 가짜 해시로 비교를 정확히 1번 (해시를 새로 만들지 않음)', async () => {
    const { hasher, service } = setup()

    assert.equal(await service.login({ email: 'nobody@example.com', password: PASSWORD }), null)
    assert.deepEqual(hasher.calls.verify, [DUMMY_HASH])
    assert.equal(hasher.calls.hash.length, 0, '요청마다 가짜 해시를 만들면 안 됨')
  })

  it('가짜 해시가 없으면 서비스를 만들 수 없다 (시작할 때 준비해야 함)', () => {
    assert.throws(
      () => createEmailAccountService({ userRepository: createMemoryRepository(), passwordHasher: createFakeHasher() }),
      /dummyPasswordHash/,
    )
  })
})

describe('없는 이메일용 가짜 해시 (createDummyPasswordHash)', () => {
  const hasher = createPasswordHasher()

  it('실제 해시와 같은 파라미터(argon2id m=19456 t=2 p=1)의 해시다', async () => {
    const dummy = await createDummyPasswordHash(hasher)
    const real = await hasher.hash(PASSWORD)

    const params = (hash) => hash.split('$').slice(1, 4).join('$')
    assert.equal(params(dummy), params(real))
    assert.equal(params(dummy), 'argon2id$v=19$m=19456,t=2,p=1')
  })

  it('어떤 비밀번호와도 일치하지 않고, 만들 때마다 다르다 (원문을 알 수 없는 난수)', async () => {
    const dummy = await createDummyPasswordHash(hasher)

    for (const password of ['', 'password', PASSWORD]) {
      assert.equal(await hasher.verify(dummy, password), false)
    }
    assert.notEqual(await createDummyPasswordHash(hasher), dummy)
  })
})
