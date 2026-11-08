// 비밀번호 해시 계산만 담당하는 경계 레이어 (ADR 0007). 원문은 이 모듈 밖으로 나가지 않는다.
import argon2 from 'argon2'

// OWASP 권장 최솟값. 바꾸면 기존 해시는 그대로 검증되고(해시 문자열에 파라미터가 들어 있음), 새 해시만 새 값이 된다.
export const ARGON2_PARAMS = Object.freeze({ type: 'argon2id', memoryCost: 19456, timeCost: 2, parallelism: 1 })

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: ARGON2_PARAMS.memoryCost,
  timeCost: ARGON2_PARAMS.timeCost,
  parallelism: ARGON2_PARAMS.parallelism,
}

// argon2Impl: 테스트에서 라이브러리 내부 실패를 흉내 낼 때만 바꾼다
export function createPasswordHasher({ argon2Impl = argon2 } = {}) {
  // 결과: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
  function hash(password) {
    return argon2Impl.hash(password, HASH_OPTIONS)
  }

  async function verify(passwordHash, password) {
    try {
      return await argon2Impl.verify(passwordHash, password)
    } catch (err) {
      // 해시 문자열 형식이 깨진 경우(argon2가 TypeError를 던짐)만 "불일치"로 본다. 그 밖의 에러는 올린다.
      if (err instanceof TypeError) {
        return false
      }
      throw err
    }
  }

  return { hash, verify }
}
