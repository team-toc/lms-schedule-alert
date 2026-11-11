import { DuplicateIdentityError } from './user-repository.js'

export const DEFAULT_DISPLAY_NAME = '사용자'
// migrations/0001_create_users.up.sql 의 display_name VARCHAR(100) 과 같아야 한다
export const DISPLAY_NAME_MAX_LENGTH = 100

const graphemeSegmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' })

export class AccountLookupError extends Error {
  constructor() {
    super('중복 키 후 기존 계정을 다시 찾지 못함')
    this.name = 'AccountLookupError'
  }
}

// DB 길이는 코드포인트 기준이라 코드포인트 수로 세되, 글자(자소 · 이모지 묶음) 중간에서는 자르지 않는다
function truncateToMaxLength(text) {
  let result = ''
  let length = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentLength = [...segment].length
    if (length + segmentLength > DISPLAY_NAME_MAX_LENGTH) {
      break
    }
    result += segment
    length += segmentLength
  }
  return result
}

export function normalizeDisplayName(nickname) {
  const trimmed = (nickname ?? '').trim()
  if (trimmed === '') {
    return DEFAULT_DISPLAY_NAME
  }
  return truncateToMaxLength(trimmed)
}

export function createAccountService({ userRepository }) {
  // 로그인 수단으로 사용자를 찾고, 없으면 만든다. 기존 사용자의 display_name은 바꾸지 않는다.
  async function loginWithIdentity({ provider, providerUserId, displayName }) {
    const existing = await userRepository.findUserByIdentity({ provider, providerUserId })
    if (existing) {
      return { user: existing, isNewUser: false }
    }

    try {
      const user = await userRepository.createUserWithIdentity({
        provider,
        providerUserId,
        displayName: normalizeDisplayName(displayName),
      })
      return { user, isNewUser: true }
    } catch (err) {
      if (!(err instanceof DuplicateIdentityError)) {
        throw err
      }
    }

    // 동시 요청이 먼저 만들었다. 저장소가 이미 롤백했으므로 새 조회는 커밋된 계정을 본다.
    const winner = await userRepository.findUserByIdentity({ provider, providerUserId })
    if (!winner) {
      throw new AccountLookupError()
    }
    return { user: winner, isNewUser: false }
  }

  function findUserById(id) {
    return userRepository.findUserById(id)
  }

  return { loginWithIdentity, findUserById }
}
