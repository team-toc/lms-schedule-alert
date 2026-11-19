import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { openTestContext } from './helpers/test-context.js'
import { createFakeCanvas, canvasCourse, canvasAssignment } from './helpers/fake-canvas.js'
import { buildLmsApp, connectUser, tokenRow } from './helpers/lms-context.js'

const USER_COUNT = 5
const DEFAULT_CONCURRENCY = 2
const tokenFor = (n) => `7~LimitUser${n}0123456789abcdefghijklmnopqrstuvwxyz`
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('동기화 동시 실행 상한 (DB · 실제 서비스 조립)', () => {
  let ctx

  before(async () => {
    ctx = await openTestContext()
    await ctx.resetDatabase()
  })
  after(async () => {
    await ctx.close()
  })

  it('동기화 요청이 상한(2)보다 많아도 Canvas로 동시에 2개까지만 나가고, 그동안 /api/auth/me는 응답한다', async () => {
    const canvas = createFakeCanvas()
    const built = buildLmsApp(ctx, { canvas })
    const users = []
    for (let n = 1; n <= USER_COUNT; n += 1) {
      canvas.addAccount(tokenFor(n), { id: 9000 + n })
      canvas.setCourses(tokenFor(n), [canvasCourse(101)])
      canvas.setAssignments(tokenFor(n), 101, [canvasAssignment(101, 501)])
      users.push(await connectUser(built, { email: `u${n}@example.com`, token: tokenFor(n) }))
    }
    // 이제부터 과목 목록 요청을 붙잡아 동시에 몇 개가 Canvas에 나가 있는지 센다
    let active = 0
    let maxActive = 0
    let releaseAll
    const gate = new Promise((resolve) => {
      releaseAll = resolve
    })
    canvas.intercept(
      (r) => r.path === '/api/v1/courses',
      async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await gate
        active -= 1
      },
    )

    for (const user of users) {
      built.lms.syncRunner.requestSync(user.userId)
    }
    // 단정이 실패해도 붙잡은 요청은 반드시 풀어 준다(안 풀면 정리 단계의 whenIdle이 끝나지 않는다)
    try {
      for (let i = 0; i < 200 && active < DEFAULT_CONCURRENCY; i += 1) {
        await wait(5)
      }
      await wait(50)

      assert.equal(active, DEFAULT_CONCURRENCY, '상한만큼만 돌고 나머지는 기다린다')
      const started = Date.now()
      const me = await users[0].agent.get('/api/auth/me').expect(200)
      assert.equal(me.body.id, users[0].userId)
      assert.ok(Date.now() - started < 2000, '동기화가 밀려 있어도 일반 API는 바로 응답한다')
    } finally {
      releaseAll()
    }
    await built.lms.syncRunner.whenIdle()

    assert.equal(maxActive, DEFAULT_CONCURRENCY)
    for (const user of users) {
      assert.equal((await tokenRow(ctx.pool, user.userId)).status, 'ok')
    }
  })
})
