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
})
