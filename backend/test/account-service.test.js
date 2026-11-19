import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAccountService, DEFAULT_DISPLAY_NAME, DISPLAY_NAME_MAX_LENGTH } from '../src/accounts/account-service.js'
import { DuplicateIdentityError } from '../src/accounts/user-repository.js'

const KAKAO_IDENTITY = { provider: 'kakao', providerUserId: '4000000001', displayName: '테스트사용자' }

// DB 없이 계정 로직만 확인하는 메모리 저장소.
// loseRaceOnce: 처음 생성 시도에서 "다른 요청이 먼저 만들었다" 상황을 흉내 낸다.
// failCreateWith: 생성 시 이 에러를 던진다 (중복 키가 아닌 DB 에러 흉내).
// 실제 격리 수준(REPEATABLE READ) 문제는 메모리로 재현되지 않으므로 auth-login 3번 DB 테스트가 맡는다.
function createMemoryUserRepository({ loseRaceOnce = false, failCreateWith = null } = {}) {
  const users = []
  const identities = []
  const calls = { findByIdentity: 0, create: 0 }
  let raceToLose = loseRaceOnce
  const insert = ({ provider, providerUserId, displayName }) => {
    const user = { id: users.length + 1, displayName, onboardingStep: 'lms_token' }
    users.push(user)
    identities.push({ provider, providerUserId, userId: user.id })
    return user
  }
  return {
    users,
    calls,
    async findUserByIdentity({ provider, providerUserId }) {
      calls.findByIdentity += 1
      const identity = identities.find((i) => i.provider === provider && i.providerUserId === providerUserId)
      return identity ? users.find((u) => u.id === identity.userId) : null
    },
    async findUserById(id) {
      return users.find((u) => u.id === id) ?? null
    },
    async createUserWithIdentity(identity) {
      calls.create += 1
      if (failCreateWith) {
        throw failCreateWith
      }
      if (raceToLose) {
        raceToLose = false
        insert({ ...identity, displayName: '먼저 만든 요청' })
        throw new DuplicateIdentityError()
      }
      return insert(identity)
    },
  }
}

async function displayNameAfterSignup(nickname) {
  const service = createAccountService({ userRepository: createMemoryUserRepository() })
  const { user } = await service.loginWithIdentity({ ...KAKAO_IDENTITY, displayName: nickname })
  return user.displayName
}

describe('계정 조회 · 생성 (accountService.loginWithIdentity)', () => {
  it('처음 보는 로그인 수단이면 사용자를 만들고 isNewUser = true', async () => {
    const repo = createMemoryUserRepository()
    const service = createAccountService({ userRepository: repo })

    const { user, isNewUser } = await service.loginWithIdentity(KAKAO_IDENTITY)

    assert.equal(isNewUser, true)
    assert.equal(user.displayName, '테스트사용자')
    assert.equal(user.onboardingStep, 'lms_token')
    assert.equal(repo.users.length, 1)
  })

  it('이미 있는 로그인 수단이면 만들지 않고 기존 사용자를 돌려준다', async () => {
    const repo = createMemoryUserRepository()
    const service = createAccountService({ userRepository: repo })
    const first = await service.loginWithIdentity(KAKAO_IDENTITY)

    const second = await service.loginWithIdentity(KAKAO_IDENTITY)

    assert.equal(second.isNewUser, false)
    assert.equal(second.user.id, first.user.id)
    assert.equal(repo.calls.create, 1)
  })

  it('재로그인 시 닉네임이 바뀌어도 display_name은 처음 값을 유지한다', async () => {
    const repo = createMemoryUserRepository()
    const service = createAccountService({ userRepository: repo })
    await service.loginWithIdentity(KAKAO_IDENTITY)

    const { user } = await service.loginWithIdentity({ ...KAKAO_IDENTITY, displayName: '바뀐닉네임' })

    assert.equal(user.displayName, '테스트사용자')
    assert.equal(repo.users[0].displayName, '테스트사용자')
  })

  it('생성 중 중복 키(동시 요청에 짐) → 새 조회로 먼저 만들어진 사용자를 돌려준다', async () => {
    const repo = createMemoryUserRepository({ loseRaceOnce: true })
    const service = createAccountService({ userRepository: repo })

    const { user, isNewUser } = await service.loginWithIdentity(KAKAO_IDENTITY)

    assert.equal(isNewUser, false)
    assert.equal(user.displayName, '먼저 만든 요청')
    assert.equal(repo.users.length, 1)
    assert.equal(repo.calls.findByIdentity, 2, '중복 키 뒤에 한 번 더 조회해야 함')
  })

  it('중복 키가 아닌 DB 에러는 삼키지 않고 그대로 올리며 재조회하지 않는다', async () => {
    const dbError = Object.assign(new Error('Lost connection'), { code: 'PROTOCOL_CONNECTION_LOST' })
    const repo = createMemoryUserRepository({ failCreateWith: dbError })
    const service = createAccountService({ userRepository: repo })

    await assert.rejects(service.loginWithIdentity(KAKAO_IDENTITY), (err) => err === dbError)
    assert.equal(repo.calls.findByIdentity, 1)
  })

  it('findUserById: 없는 사용자 id면 null', async () => {
    const service = createAccountService({ userRepository: createMemoryUserRepository() })

    assert.equal(await service.findUserById(999), null)
  })
})

describe('표시 이름 정리 (가입 시 display_name)', () => {
  it('기본 이름은 "사용자"', () => {
    assert.equal(DEFAULT_DISPLAY_NAME, '사용자')
  })

  for (const [label, nickname] of [['null', null], ['undefined', undefined], ['빈 문자열', ''], ['공백만', ' \t\n　 ']]) {
    it(`닉네임이 ${label}이면 기본 이름`, async () => {
      assert.equal(await displayNameAfterSignup(nickname), DEFAULT_DISPLAY_NAME)
    })
  }

  it('앞뒤 공백을 제거한다', async () => {
    assert.equal(await displayNameAfterSignup('  홍 길동  '), '홍 길동')
  })

  it('길이를 넘는 한글 닉네임은 문자 단위로 잘라 정확히 최대 길이가 된다', async () => {
    const name = await displayNameAfterSignup('가'.repeat(DISPLAY_NAME_MAX_LENGTH + 50))

    assert.equal(name, '가'.repeat(DISPLAY_NAME_MAX_LENGTH))
  })

  it('이모지(서로게이트 쌍)를 반쪽으로 자르지 않는다', async () => {
    const name = await displayNameAfterSignup('a' + '😀'.repeat(DISPLAY_NAME_MAX_LENGTH))

    assert.equal([...name].length, DISPLAY_NAME_MAX_LENGTH)
    assert.ok(name.isWellFormed(), '깨진 서로게이트가 없어야 함')
  })

  it('여러 코드포인트로 된 이모지(가족 이모지)도 중간에서 자르지 않는다', async () => {
    const family = '👨‍👩‍👧'
    const name = await displayNameAfterSignup(family.repeat(DISPLAY_NAME_MAX_LENGTH))

    assert.ok([...name].length <= DISPLAY_NAME_MAX_LENGTH)
    assert.equal(name.replaceAll(family, ''), '', '가족 이모지 단위로만 남아야 함')
  })
})
