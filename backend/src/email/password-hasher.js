// 비밀번호 해시 계산만 담당하는 경계 레이어 (ADR 0007). 원문은 이 모듈 밖으로 나가지 않는다.
import argon2 from 'argon2'

// OWASP 권장 최솟값. 바꾸면 기존 해시는 그대로 검증되고(해시 문자열에 파라미터가 들어 있음), 새 해시만 새 값이 된다.
export const ARGON2_PARAMS = Object.freeze({ type: 'argon2id', memoryCost: 19456, timeCost: 2, parallelism: 1 })

// verify 전에 확인하는 저장 형식: $argon2id$v=<버전>$m=<메모리>,t=<반복>,p=<병렬>$<salt>$<hash>
const ARGON2ID_HASH_PATTERN = /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/

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

  // 저장된 해시가 argon2id 형식이 아니면 "불일치". 형식이 맞는데 나는 에러(잘못된 비밀번호 타입 등)는 모두 올린다.
  async function verify(passwordHash, password) {
    if (typeof passwordHash !== 'string' || !ARGON2ID_HASH_PATTERN.test(passwordHash)) {
      return false
    }
    return argon2Impl.verify(passwordHash, password)
  }

  return { hash, verify }
}
