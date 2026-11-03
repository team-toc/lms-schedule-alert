import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb } from './helpers/test-db.js'
import { createUserRepository, DuplicateIdentityError } from '../src/accounts/user-repository.js'
import { createAccountService, DISPLAY_NAME_MAX_LENGTH } from '../src/accounts/account-service.js'

const IDENTITY = { provider: 'kakao', providerUserId: '4000000001', displayName: '테스트사용자' }

describe('MariaDB 사용자 저장소', () => {
  let db
  let repo

  before(async () => {
    db = await openTestDb()
    repo = createUserRepository(db.pool)
  })
  beforeEach(async () => {
    await db.resetDatabase()
  })
  after(async () => {
    await db.pool.end()
  })

  it('createUserWithIdentity: users · auth_identities를 함께 만들고 사용자를 돌려준다', async () => {
    const user = await repo.createUserWithIdentity(IDENTITY)

    assert.deepEqual(Object.keys(user).sort(), ['displayName', 'id', 'onboardingStep'])
    assert.equal(user.displayName, IDENTITY.displayName)
    assert.equal(user.onboardingStep, 'lms_token')
    assert.equal(await db.countRows('users'), 1)
    assert.equal(await db.countRows('auth_identities'), 1)
  })

  it('findUserByIdentity · findUserById: 만든 사용자를 찾고, 없으면 null', async () => {
    const created = await repo.createUserWithIdentity(IDENTITY)

    assert.deepEqual(await repo.findUserByIdentity(IDENTITY), created)
    assert.deepEqual(await repo.findUserById(created.id), created)
    assert.equal(await repo.findUserByIdentity({ provider: 'kakao', providerUserId: 'nobody' }), null)
    assert.equal(await repo.findUserById(created.id + 1000), null)
  })

  it('같은 로그인 수단을 또 만들면 DuplicateIdentityError, 롤백되어 고아 users 행이 없다', async () => {
    await repo.createUserWithIdentity(IDENTITY)

    await assert.rejects(repo.createUserWithIdentity({ ...IDENTITY, displayName: '두번째' }), DuplicateIdentityError)

    assert.equal(await db.countRows('users'), 1)
    assert.equal(await db.countRows('auth_identities'), 1)
  })

  it('중복 키가 아닌 DB 에러는 원래 에러 그대로 올리고, 트랜잭션은 롤백된다', async () => {
    // provider ENUM에 없는 값 → strict 모드에서 데이터 잘림 에러 (중복 키 아님)
    const invalid = { ...IDENTITY, provider: 'unknown-provider' }

    await assert.rejects(repo.createUserWithIdentity(invalid), (err) => {
      assert.ok(!(err instanceof DuplicateIdentityError))
      assert.equal(err.code, 'WARN_DATA_TRUNCATED')
      return true
    })
    assert.equal(await db.countRows('users'), 0)
  })

  it('실패한 트랜잭션 뒤에도 연결이 풀에 정상 반납되어 다음 요청이 동작한다', async () => {
    for (let i = 0; i < 15; i += 1) {
      await assert.rejects(repo.createUserWithIdentity({ ...IDENTITY, provider: 'unknown-provider' }))
    }

    const user = await repo.createUserWithIdentity(IDENTITY)

    assert.ok(user.id)
  })

  it('계정 로직 + DB: 긴 한글 닉네임이 깨지지 않고 최대 길이로 저장된다', async () => {
    const service = createAccountService({ userRepository: repo })

    await service.loginWithIdentity({ ...IDENTITY, displayName: '한'.repeat(DISPLAY_NAME_MAX_LENGTH + 20) })

    const [[row]] = await db.pool.query('SELECT display_name, CHAR_LENGTH(display_name) AS len FROM users')
    assert.equal(row.display_name, '한'.repeat(DISPLAY_NAME_MAX_LENGTH))
    assert.equal(Number(row.len), DISPLAY_NAME_MAX_LENGTH)
  })

  it('계정 로직 + DB: 재로그인 시 display_name은 처음 값을 유지한다', async () => {
    const service = createAccountService({ userRepository: repo })
    await service.loginWithIdentity(IDENTITY)

    await service.loginWithIdentity({ ...IDENTITY, displayName: '바뀐닉네임' })

    const [[row]] = await db.pool.query('SELECT display_name FROM users')
    assert.equal(row.display_name, IDENTITY.displayName)
  })
})
