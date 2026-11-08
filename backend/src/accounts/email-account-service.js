import { randomBytes } from 'node:crypto'
import { DuplicateIdentityError } from './user-repository.js'
import { normalizeDisplayName } from './account-service.js'

const DUMMY_SECRET_BYTES = 32

export class EmailAlreadyRegisteredError extends Error {
  constructor(options) {
    super('이미 가입된 이메일', options)
    this.name = 'EmailAlreadyRegisteredError'
  }
}

// 없는 이메일로 로그인할 때 비교할 가짜 해시. 실제 해시와 같은 모듈 · 파라미터로 만들고, 서버 시작 시 한 번만 만든다.
// 원문은 버리는 난수라 어떤 비밀번호와도 일치하지 않는다.
export function createDummyPasswordHash(passwordHasher) {
  return passwordHasher.hash(randomBytes(DUMMY_SECRET_BYTES).toString('base64url'))
}

// 입력은 이미 검증 · 정규화된 값(email-input.js)이라고 가정한다
export function createEmailAccountService({ userRepository, passwordHasher, dummyPasswordHash }) {
  if (!dummyPasswordHash) {
    throw new Error('dummyPasswordHash가 필요함: 서버 시작 시 createDummyPasswordHash로 한 번 만들어 넘길 것')
  }

  // 가입하면 바로 로그인할 사용자를 돌려준다. 이미 있는 이메일이면 EmailAlreadyRegisteredError(기존 계정으로 로그인시키지 않음)
  async function signup({ email, password, displayName }) {
    const passwordHash = await passwordHasher.hash(password)
    try {
      return await userRepository.createUserWithPassword({ email, displayName: normalizeDisplayName(displayName), passwordHash })
    } catch (err) {
      if (err instanceof DuplicateIdentityError) {
        throw new EmailAlreadyRegisteredError({ cause: err })
      }
      throw err
    }
  }

  // 결과: 사용자 또는 null. 이메일이 없어도 해시 비교를 정확히 한 번 해 응답 시간 차이를 줄인다.
  async function login({ email, password }) {
    const credential = await userRepository.findEmailCredential(email)
    if (!credential) {
      await passwordHasher.verify(dummyPasswordHash, password)
      return null
    }
    const matches = await passwordHasher.verify(credential.passwordHash, password)
    return matches ? credential.user : null
  }

  return { signup, login }
}
