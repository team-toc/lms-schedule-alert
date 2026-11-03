import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAccountService, DEFAULT_DISPLAY_NAME } from '../src/accounts/account-service.js'
import { DuplicateIdentityError } from '../src/accounts/user-repository.js'

const KAKAO_IDENTITY = { provider: 'kakao', providerUserId: '4000000001', displayName: '테스트사용자' }

// DB 없이 계정 로직만 확인하는 메모리 저장소.
// loseRaceOnce: 처음 생성 시도에서 "다른 요청이 먼저 만들었다" 상황을 흉내 낸다.
// 실제 격리 수준(REPEATABLE READ) 문제는 메모리로 재현되지 않으므로 auth-login 3번 DB 테스트가 맡는다.
function createMemoryUserRepository({ loseRaceOnce = false } = {}) {
  const users = []
  const identities = []
  let raceToLose = loseRaceOnce
  const insert = ({ provider, providerUserId, displayName }) => {
    const user = { id: users.length + 1, displayName, onboardingStep: 'lms_token' }
    users.push(user)
    identities.push({ provider, providerUserId, userId: user.id })
    return user
  }
  return {
    users,
    createCalls: 0,
    async findUserByIdentity({ provider, providerUserId }) {
      const identity = identities.find((i) => i.provider === provider && i.providerUserId === providerUserId)
      return identity ? users.find((u) => u.id === identity.userId) : null
    },
    async findUserById(id) {
      return users.find((u) => u.id === id) ?? null
    },
    async createUserWithIdentity(identity) {
      this.createCalls += 1
      if (raceToLose) {
        raceToLose = false
        insert({ ...identity, displayName: '먼저 만든 요청' })
        throw new DuplicateIdentityError()
      }
      return insert(identity)
    },
  }
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
    assert.equal(repo.createCalls, 1)
  })

  it('생성 중 중복 키(동시 요청에 짐) → 먼저 만들어진 사용자를 다시 조회해 돌려준다', async () => {
    const repo = createMemoryUserRepository({ loseRaceOnce: true })
    const service = createAccountService({ userRepository: repo })

    const { user, isNewUser } = await service.loginWithIdentity(KAKAO_IDENTITY)

    assert.equal(isNewUser, false)
    assert.equal(user.displayName, '먼저 만든 요청')
    assert.equal(repo.users.length, 1)
  })

  it('닉네임이 비어 있으면 기본 표시 이름을 쓴다', async () => {
    const repo = createMemoryUserRepository()
    const service = createAccountService({ userRepository: repo })

    const { user } = await service.loginWithIdentity({ ...KAKAO_IDENTITY, displayName: null })

    assert.equal(user.displayName, DEFAULT_DISPLAY_NAME)
  })

  it('findUserById: 없는 사용자 id면 null', async () => {
    const service = createAccountService({ userRepository: createMemoryUserRepository() })

    assert.equal(await service.findUserById(999), null)
  })
})
