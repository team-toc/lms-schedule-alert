import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url))
const PROCESS_TIMEOUT_MS = 10000
// 출력에 나오면 안 되는 값. 실제 .env 값 대신 이 값들이 쓰이도록 환경변수로 넘긴다(dotenv는 이미 있는 값을 덮지 않음).
const VALUES_MUST_NOT_PRINT = {
  DB_PASSWORD: 'fake-db-password-MUST-NOT-PRINT',
  SESSION_SECRET: 'fake-session-secret-MUST-NOT-PRINT-0123456789',
  KAKAO_CLIENT_SECRET: 'fake-kakao-secret-MUST-NOT-PRINT',
}

const ENTRY_POINTS = [
  ['npm run dev (src/index.js)', ['src/index.js']],
  ['npm run migrate (scripts/migrate.js up)', ['scripts/migrate.js', 'up']],
  ['npm run migrate:status (scripts/migrate.js status)', ['scripts/migrate.js', 'status']],
]

function runWithEnv(args, envOverrides) {
  return spawnSync(process.execPath, args, {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...VALUES_MUST_NOT_PRINT, ...envOverrides },
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
  })
}

function assertOnlyKeyNames(result, { expectedLine }) {
  assert.equal(result.status, 1, '종료 코드 1로 끝나야 함')
  assert.equal(result.stdout, '', 'stdout에는 아무것도 없어야 함')
  assert.equal(result.stderr, `${expectedLine}\n`, 'stderr에는 설정 오류 한 줄만')
  assert.doesNotMatch(result.stderr, /\n\s+at /, '스택 트레이스 금지')
  for (const value of Object.values(VALUES_MUST_NOT_PRINT)) {
    assert.ok(!result.stderr.includes(value), '설정 값이 출력되면 안 됨')
  }
}

describe('실행 진입점: 설정 오류는 키 이름만 출력하고 종료', () => {
  for (const [label, args] of ENTRY_POINTS) {
    it(`${label}: 필수 값이 비면 빠진 키 이름 한 줄만`, () => {
      const result = runWithEnv(args, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })

      assertOnlyKeyNames(result, {
        expectedLine: '설정 오류: 필수 환경변수가 비어 있음: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET',
      })
    })

    it(`${label}: 필수 값 외의 설정 오류(TRUST_PROXY)도 한 줄만`, () => {
      const result = runWithEnv(args, { TRUST_PROXY: 'yes' })

      assertOnlyKeyNames(result, { expectedLine: '설정 오류: TRUST_PROXY는 true 또는 false여야 함' })
    })
  }
})
