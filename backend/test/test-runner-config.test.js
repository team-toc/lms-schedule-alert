import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// 오래 멈추는 테스트가 "통과"로 숨지 않게: 테스트(훅 포함)당 30초 제한, 끝난 뒤 남은 타이머 · 연결이 있어도 파일 프로세스를 끝낸다
describe('npm test 실행 설정', () => {
  it('테스트당 시간 제한(--test-timeout=30000)과 --test-force-exit가 있고, 파일은 하나씩(DB 공유) 돈다', async () => {
    const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

    for (const flag of ['--test-timeout=30000', '--test-force-exit', '--test-concurrency=1']) {
      assert.ok(scripts.test.split(' ').includes(flag), `npm test에 ${flag} 필요`)
    }
  })

  // 배포 서버는 UTC. 시간대에 기대는 코드(예: 날짜를 서버 현지 시간으로 읽는 라이브러리)가 개발 맥(KST)에서만 통과하지 않게
  it('npm test는 TZ=UTC로 돈다 (스크립트 맨 앞), npm test로 실행 중이면 실제 테스트 프로세스의 시간대도 UTC', async () => {
    const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

    assert.ok(scripts.test.startsWith('TZ=UTC '), 'npm test 스크립트는 TZ=UTC로 시작해야 함')
    if (process.env.npm_lifecycle_event === 'test') {
      assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), 0, '테스트 프로세스 시간대가 UTC가 아님')
      assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC')
    }
  })
})
