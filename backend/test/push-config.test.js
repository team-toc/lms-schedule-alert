import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createECDH } from 'node:crypto'
import { loadPushConfig } from '../src/push/push-config.js'
import { ConfigError } from '../src/config.js'
import { childProcessEnv } from './helpers/child-env.js'
import { generateVapidKeys } from './helpers/push-context.js'

const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url))
const PROCESS_TIMEOUT_MS = 8000
const KEYS = generateVapidKeys()
const VALID = { VAPID_PUBLIC_KEY: KEYS.publicKey, VAPID_PRIVATE_KEY: KEYS.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' }
const b64url = (buf) => Buffer.from(buf).toString('base64url')

// 틀린 값은 메시지에 들어가면 안 된다(키 이름만)
function assertConfigError(env, keyName) {
  let thrown
  try {
    loadPushConfig(env)
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof ConfigError, `ConfigError여야 함: ${keyName}`)
  assert.match(thrown.message, new RegExp(keyName))
  for (const value of [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter((v) => typeof v === 'string' && v.length > 8)) {
    assert.ok(!thrown.message.includes(value), '설정 값이 메시지에 있으면 안 됨')
  }
}

// VAPID 설정 (ADR 0012): 공개키 65바이트 비압축 · 개인키 32바이트(base64url), 둘이 짝, 연락처는 mailto: 또는 https:
describe('푸시 설정 (VAPID)', () => {
  it('올바른 값 → { vapidPublicKey, vapidPrivateKey, vapidSubject }, https 연락처도 된다', () => {
    assert.deepEqual(loadPushConfig(VALID), { vapidPublicKey: KEYS.publicKey, vapidPrivateKey: KEYS.privateKey, vapidSubject: 'mailto:ops@example.com' })
    assert.equal(loadPushConfig({ ...VALID, VAPID_SUBJECT: 'https://lms.example.ac.kr/contact' }).vapidSubject, 'https://lms.example.ac.kr/contact')
  })

  it('없으면 빠진 키 이름을 모두 담은 설정 오류', () => {
    assert.throws(() => loadPushConfig({}), (err) => err instanceof ConfigError && /VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT/.test(err.message))
    for (const key of Object.keys(VALID)) {
      assertConfigError({ ...VALID, [key]: '' }, key)
    }
  })

  it('공개키 형식: base64url · 65바이트 · 0x04 시작이 아니면 VAPID_PUBLIC_KEY 오류(값은 안 나옴)', () => {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    for (const bad of [
      KEYS.publicKey.slice(0, -4),
      `${KEYS.publicKey}AAAA`,
      Buffer.from(ecdh.getPublicKey()).toString('base64'),
      b64url(ecdh.getPublicKey(null, 'compressed')),
      b64url(Buffer.concat([Buffer.from([0x05]), ecdh.getPublicKey().subarray(1)])),
      'not base64 url!!',
    ]) {
      assertConfigError({ ...VALID, VAPID_PUBLIC_KEY: bad }, 'VAPID_PUBLIC_KEY')
    }
  })

  it('개인키 형식: base64url · 32바이트가 아니면 VAPID_PRIVATE_KEY 오류', () => {
    for (const bad of [KEYS.privateKey.slice(0, -2), `${KEYS.privateKey}AA`, Buffer.alloc(32, 1).toString('base64') + '=']) {
      assertConfigError({ ...VALID, VAPID_PRIVATE_KEY: bad }, 'VAPID_PRIVATE_KEY')
    }
  })

  it('개인키에서 계산한 공개키가 VAPID_PUBLIC_KEY와 다르면(짝이 안 맞으면) 설정 오류', () => {
    const other = generateVapidKeys()
    assertConfigError({ ...VALID, VAPID_PRIVATE_KEY: other.privateKey }, 'VAPID_PRIVATE_KEY')
  })

  it('연락처: mailto:주소 또는 https:// 주소만', () => {
    for (const bad of ['ops@example.com', 'mailto:', 'http://example.com', 'https://', 'javascript:alert(1)', 'mailto:not-an-address']) {
      assertConfigError({ ...VALID, VAPID_SUBJECT: bad }, 'VAPID_SUBJECT')
    }
  })
})

// 실제 서버 시작: Canvas 설정은 올바르고 VAPID만 없거나 틀리면 키 이름 한 줄만 출력하고 종료
const SERVER_ENV = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_NAME: 'never_connected',
  DB_USER: 'nobody',
  DB_PASSWORD: 'unused-db-password',
  SESSION_SECRET: 'push-config-test-session-secret-0123456789',
  FRONTEND_URL: 'http://frontend.test',
  KAKAO_REST_API_KEY: 'fake',
  KAKAO_CLIENT_SECRET: 'fake',
  KAKAO_REDIRECT_URI: 'http://backend.test/api/auth/kakao/callback',
  GOOGLE_CLIENT_ID: 'fake',
  GOOGLE_CLIENT_SECRET: 'fake',
  GOOGLE_REDIRECT_URI: 'http://backend.test/api/auth/google/callback',
  CANVAS_BASE_URL: 'https://canvas.example.ac.kr',
  CANVAS_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64'),
}

function runServer(overrides) {
  // 설정 오류면 바로 끝난다. 혹시 서버가 떠 버려도(검사 누락) 시간 제한에 SIGKILL로 끊어 테스트가 멈추지 않게(SIGTERM이면 정상 종료를 기다림)
  return spawnSync(process.execPath, ['src/index.js'], {
    cwd: BACKEND_DIR,
    env: childProcessEnv({ PORT: String(40000 + Math.floor(Math.random() * 20000)), ...SERVER_ENV, ...overrides }),
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
}

describe('서버 시작: VAPID 설정이 없거나 틀리면 키 이름만 출력하고 종료', () => {
  it('셋 다 없으면 빠진 키 이름 한 줄, 종료 코드 1', () => {
    const result = runServer({})

    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '설정 오류: 필수 환경변수가 비어 있음: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT\n')
  })

  it('짝이 안 맞는 개인키 → 키 이름만 한 줄, 키 값은 출력하지 않는다', () => {
    const other = generateVapidKeys()
    const result = runServer({ ...VALID, VAPID_PRIVATE_KEY: other.privateKey })

    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stderr.split('\n').filter(Boolean).length, 1)
    assert.match(result.stderr, /^설정 오류: .*VAPID_PRIVATE_KEY/)
    for (const value of [other.privateKey, KEYS.publicKey, KEYS.privateKey]) {
      assert.ok(!result.stderr.includes(value), '키 값이 출력되면 안 됨')
    }
  })
})
