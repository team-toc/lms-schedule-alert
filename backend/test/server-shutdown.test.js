import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testDbConnectionEnv } from './helpers/test-db.js'
import { childProcessEnv } from './helpers/child-env.js'

const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url))
const START_TIMEOUT_MS = 10000
const EXIT_TIMEOUT_MS = 10000
const PORT = 40000 + Math.floor(Math.random() * 20000)

// 실제 서버(src/index.js)를 테스트 DB에 붙여 띄운다. Canvas는 부르지 않는다(첫 주기 실행은 한 주기 뒤).
function serverEnv() {
  const { TEST_DB_NAME, DB_NAME: _devDb, ...connection } = testDbConnectionEnv()
  return childProcessEnv({
    ...connection,
    DB_NAME: TEST_DB_NAME,
    PORT: String(PORT),
    SESSION_SECRET: 'server-shutdown-test-secret-0123456789abcdef',
    FRONTEND_URL: 'http://frontend.test',
    KAKAO_REST_API_KEY: 'fake',
    KAKAO_CLIENT_SECRET: 'fake',
    KAKAO_REDIRECT_URI: 'http://backend.test/api/auth/kakao/callback',
    GOOGLE_CLIENT_ID: 'fake',
    GOOGLE_CLIENT_SECRET: 'fake',
    GOOGLE_REDIRECT_URI: 'http://backend.test/api/auth/google/callback',
    CANVAS_BASE_URL: 'https://canvas.unused.test',
    CANVAS_TOKEN_KEY: Buffer.alloc(32, 3).toString('base64'),
    LOG_LEVEL: 'info',
  })
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      if (predicate()) {
        return resolve()
      }
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`${label} 시간 초과`))
      }
      setTimeout(check, 20)
    }
    check()
  })
}

describe('실제 서버: SIGTERM이면 정상 종료한다', () => {
  it('시작 로그 → /api/health 200 → SIGTERM → shutdown_started · shutdown_finished, 종료 코드 0', async () => {
    const child = spawn(process.execPath, ['src/index.js'], { cwd: BACKEND_DIR, env: serverEnv() })
    let stdout = ''
    let stderr = ''
    let exitCode
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve((exitCode = code))))
    try {
      await waitFor(() => stdout.includes('"msg":"backend started"') || exitCode !== undefined, START_TIMEOUT_MS, '서버 시작')
      assert.equal(exitCode, undefined, `서버가 바로 종료됨: ${stderr}`)
      const health = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      assert.equal(health.status, 200)

      child.kill('SIGTERM')
      await Promise.race([exited, waitFor(() => false, EXIT_TIMEOUT_MS, '서버 종료')])

      assert.equal(exitCode, 0, stderr)
      const events = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event)
      assert.ok(events.includes('shutdown_started') && events.includes('shutdown_finished'), stdout)
    } finally {
      if (exitCode === undefined) {
        child.kill('SIGKILL')
      }
    }
  })
})
