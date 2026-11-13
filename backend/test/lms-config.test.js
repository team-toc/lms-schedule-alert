import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadLmsConfig } from '../src/lms/lms-config.js'
import { ConfigError } from '../src/config.js'
import { childProcessEnv } from './helpers/child-env.js'

const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url))
const PROCESS_TIMEOUT_MS = 10000
const VALID_KEY_BYTES = Buffer.alloc(32, 1)
const VALID_ENV = { CANVAS_BASE_URL: 'https://canvas.example.ac.kr', CANVAS_TOKEN_KEY: VALID_KEY_BYTES.toString('base64') }
const PROD = { isProduction: true }
const DEV = { isProduction: false }
const KEY_MESSAGE = 'CANVAS_TOKEN_KEY는 32바이트 값을 base64로 인코딩한 문자열이어야 함'

function assertConfigError(env, options, pattern, mustNotInclude = []) {
  assert.throws(
    () => loadLmsConfig(env, options),
    (err) => {
      assert.ok(err instanceof ConfigError, `ConfigError여야 함: ${err}`)
      assert.match(err.message, pattern)
      for (const value of mustNotInclude) {
        assert.ok(!err.message.includes(value), '에러 메시지에 설정 값이 들어가면 안 됨')
      }
      return true
    },
  )
}

describe('Canvas 설정 (loadLmsConfig)', () => {
  it('올바른 값이면 주소 · 키(32바이트) · 주기(기본 30분)를 돌려준다', () => {
    assert.deepEqual(loadLmsConfig(VALID_ENV, PROD), {
      canvasBaseUrl: 'https://canvas.example.ac.kr',
      tokenKey: VALID_KEY_BYTES,
      syncIntervalMs: 30 * 60 * 1000,
    })
  })

  it('주소 끝의 / 는 지운다', () => {
    assert.equal(loadLmsConfig({ ...VALID_ENV, CANVAS_BASE_URL: 'https://canvas.example.ac.kr/' }, PROD).canvasBaseUrl, 'https://canvas.example.ac.kr')
  })

  it('LMS_SYNC_INTERVAL_MINUTES: 정수면 그 분, 아니면 키 이름만 담은 설정 오류', () => {
    assert.equal(loadLmsConfig({ ...VALID_ENV, LMS_SYNC_INTERVAL_MINUTES: '10' }, PROD).syncIntervalMs, 10 * 60 * 1000)
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      assertConfigError({ ...VALID_ENV, LMS_SYNC_INTERVAL_MINUTES: bad }, PROD, /^LMS_SYNC_INTERVAL_MINUTES는 1 이상의 정수여야 함$/)
    }
  })

  it('필수 값이 비면 빠진 키 이름만 알려 준다', () => {
    assertConfigError({}, PROD, /^필수 환경변수가 비어 있음: CANVAS_BASE_URL, CANVAS_TOKEN_KEY$/)
    assertConfigError({ CANVAS_BASE_URL: VALID_ENV.CANVAS_BASE_URL }, PROD, /^필수 환경변수가 비어 있음: CANVAS_TOKEN_KEY$/)
  })

  it('14. 키 형식 오류(base64 아님 · 32바이트 아님 · base64url · 공백)는 키 이름만, 값은 메시지에 없다', () => {
    const badKeys = [
      'not-base64-MUST-NOT-PRINT!!',
      Buffer.alloc(16, 1).toString('base64'),
      Buffer.alloc(33, 1).toString('base64'),
      Buffer.alloc(32, 0xfb).toString('base64url'),
      ` ${VALID_ENV.CANVAS_TOKEN_KEY}`,
    ]
    for (const key of badKeys) {
      assertConfigError({ ...VALID_ENV, CANVAS_TOKEN_KEY: key }, PROD, new RegExp(`^${KEY_MESSAGE}$`), [key.trim()])
    }
  })

  it('CANVAS_BASE_URL은 경로 · 쿼리 · 계정 정보 없는 https 주소만 (값은 메시지에 없음)', () => {
    for (const url of ['canvas.example.ac.kr', 'ftp://canvas.example.ac.kr', 'https://canvas.example.ac.kr/sub', 'https://canvas.example.ac.kr?x=1', 'https://u:p@canvas.example.ac.kr']) {
      assertConfigError({ ...VALID_ENV, CANVAS_BASE_URL: url }, PROD, /^CANVAS_BASE_URL은 /, [url])
    }
  })

  it('http는 운영(production)이 아닐 때만 허용한다', () => {
    const env = { ...VALID_ENV, CANVAS_BASE_URL: 'http://localhost:3000' }
    assert.equal(loadLmsConfig(env, DEV).canvasBaseUrl, 'http://localhost:3000')
    assertConfigError(env, PROD, /^CANVAS_BASE_URL은 /)
  })
})

// 서버 진입점(src/index.js)은 DB에 연결하기 전에 Canvas 설정을 검사하고, 틀리면 키 이름 한 줄만 출력하고 종료한다
const VALUES_MUST_NOT_PRINT = { DB_PASSWORD: 'fake-db-password-MUST-NOT-PRINT', SESSION_SECRET: 'fake-session-secret-MUST-NOT-PRINT-0123456789' }
const BASE_FAKE_ENV = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_NAME: 'lms_schedule_alert',
  DB_USER: 'fake-db-user',
  FRONTEND_URL: 'http://frontend.test',
  KAKAO_REST_API_KEY: 'fake-kakao-rest-api-key',
  KAKAO_CLIENT_SECRET: 'fake-kakao-secret',
  KAKAO_REDIRECT_URI: 'http://backend.test/api/auth/kakao/callback',
  GOOGLE_CLIENT_ID: 'fake-google-client-id',
  GOOGLE_CLIENT_SECRET: 'fake-google-client-secret',
  GOOGLE_REDIRECT_URI: 'http://backend.test/api/auth/google/callback',
  ...VALUES_MUST_NOT_PRINT,
}

function runServer(envOverrides) {
  return spawnSync(process.execPath, ['src/index.js'], {
    cwd: BACKEND_DIR,
    env: childProcessEnv({ ...BASE_FAKE_ENV, ...envOverrides }),
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
  })
}

function assertSingleLine(result, expectedLine, mustNotPrint = []) {
  assert.equal(result.status, 1, `종료 코드 1이어야 함 (stderr: ${result.stderr})`)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `${expectedLine}\n`)
  for (const value of [...Object.values(VALUES_MUST_NOT_PRINT), ...mustNotPrint]) {
    assert.ok(!result.stderr.includes(value), '설정 값이 출력되면 안 됨')
  }
}

describe('14. 서버 시작: Canvas 키가 없거나 형식이 틀리면 키 이름만 출력하고 종료', () => {
  it('CANVAS_BASE_URL · CANVAS_TOKEN_KEY가 없으면 빠진 키 이름 한 줄', () => {
    assertSingleLine(runServer({}), '설정 오류: 필수 환경변수가 비어 있음: CANVAS_BASE_URL, CANVAS_TOKEN_KEY')
  })

  it('키 형식이 틀리면 키 이름 한 줄, 키 값은 출력하지 않는다', () => {
    const badKey = 'short-key-MUST-NOT-PRINT'
    const result = runServer({ CANVAS_BASE_URL: 'https://canvas.example.ac.kr', CANVAS_TOKEN_KEY: badKey })

    assertSingleLine(result, `설정 오류: ${KEY_MESSAGE}`, [badKey])
  })
})
