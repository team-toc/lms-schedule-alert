import { createUserRepository, DuplicateIdentityError } from '../../src/accounts/user-repository.js'

// n번 호출될 때까지 모두 기다리게 하는 장벽. 풀린 뒤의 호출은 바로 통과한다.
function createBarrier(count) {
  let arrived = 0
  let release
  const allArrived = new Promise((resolve) => {
    release = resolve
  })
  return async () => {
    arrived += 1
    if (arrived === count) {
      release()
    }
    await allArrived
  }
}

// 실제 DB 저장소를 감싸, 동시 요청 2개가 "둘 다 조회 결과 없음"을 본 뒤에야 생성으로 넘어가게 한다.
// 그래서 두 요청이 반드시 INSERT에서 부딪치고, 한쪽은 중복 키 → 롤백 → 새 조회 경로를 탄다.
export function createRacingUserRepository(pool, { logger, racers = 2 }) {
  const real = createUserRepository(pool, { logger })
  const bothLookedUp = createBarrier(racers)
  const stats = { duplicateErrors: 0 }
  return {
    stats,
    findUserById: (id) => real.findUserById(id),
    async findUserByIdentity(identity) {
      const user = await real.findUserByIdentity(identity)
      await bothLookedUp()
      return user
    },
    async createUserWithIdentity(identity) {
      try {
        return await real.createUserWithIdentity(identity)
      } catch (err) {
        if (err instanceof DuplicateIdentityError) {
          stats.duplicateErrors += 1
        }
        throw err
      }
    },
    // 이메일 가입: 조회 없이 바로 생성하므로 장벽 없이 중복 키 횟수만 센다
    findEmailCredential: (email) => real.findEmailCredential(email),
    async createUserWithPassword(input) {
      try {
        return await real.createUserWithPassword(input)
      } catch (err) {
        if (err instanceof DuplicateIdentityError) {
          stats.duplicateErrors += 1
        }
        throw err
      }
    },
  }
}
