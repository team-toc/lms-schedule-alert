import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from '../src/config.js'

const VALID_ENV = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_NAME: 'lms_schedule_alert',
  DB_USER: 'lms_app',
  DB_PASSWORD: 'db-password-MUST-NOT-PRINT',
  SESSION_SECRET: 'session-secret-0123456789abcdef-xyz',
  FRONTEND_URL: 'http://frontend.test',
  KAKAO_REST_API_KEY: 'rest-key-MUST-NOT-PRINT',
  KAKAO_CLIENT_SECRET: 'client-secret-MUST-NOT-PRINT',
  KAKAO_REDIRECT_URI: 'http://backend.test/api/auth/kakao/callback',
  GOOGLE_CLIENT_ID: 'google-client-id-MUST-NOT-PRINT',
  GOOGLE_CLIENT_SECRET: 'google-client-secret-MUST-NOT-PRINT',
  GOOGLE_REDIRECT_URI: 'http://backend.test/api/auth/google/callback',
}
const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']

function assertConfigErrorNamesOnly(env, expectedKeys) {
  assert.throws(
    () => loadConfig(env),
    (err) => {
      assert.ok(err instanceof ConfigError)
      for (const key of expectedKeys) {
        assert.match(err.message, new RegExp(key))
      }
      for (const value of Object.values(VALID_ENV)) {
        assert.ok(!err.message.includes(value), '에러 메시지에 설정 값이 들어가면 안 됨')
      }
      return true
    },
  )
}

describe('설정 검증 (loadConfig)', () => {
  it('필수 값이 모두 있으면 설정 객체를 돌려준다', () => {
    const config = loadConfig(VALID_ENV)

    assert.equal(config.kakao.clientSecret, VALID_ENV.KAKAO_CLIENT_SECRET)
    assert.equal(config.isProduction, false)
  })

  it('KAKAO_CLIENT_SECRET이 비어 있으면 키 이름을 알려 주고 실패한다 (값은 출력하지 않음)', () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, KAKAO_CLIENT_SECRET: '' }),
      (err) => {
        assert.ok(err instanceof ConfigError)
        assert.match(err.message, /KAKAO_CLIENT_SECRET/)
        for (const value of Object.values(VALID_ENV)) {
          assert.ok(!err.message.includes(value), '에러 메시지에 설정 값이 들어가면 안 됨')
        }
        return true
      },
    )
  })

  it('Google 설정을 config.google로 돌려준다', () => {
    assert.deepEqual(loadConfig(VALID_ENV).google, {
      clientId: VALID_ENV.GOOGLE_CLIENT_ID,
      clientSecret: VALID_ENV.GOOGLE_CLIENT_SECRET,
      redirectUri: VALID_ENV.GOOGLE_REDIRECT_URI,
    })
  })

  for (const key of GOOGLE_KEYS) {
    it(`10. ${key}가 비어 있으면 키 이름만 알려 주고 실패한다`, () => {
      assertConfigErrorNamesOnly({ ...VALID_ENV, [key]: '' }, [key])
    })
  }

  it('10. GOOGLE_* 세 개가 모두 없으면 세 키 이름을 모두 알려 준다', () => {
    const env = { ...VALID_ENV }
    GOOGLE_KEYS.forEach((key) => delete env[key])

    assertConfigErrorNamesOnly(env, GOOGLE_KEYS)
  })

  it('로그인 실패 제한 기본값: 5회 · 15분', () => {
    assert.deepEqual(loadConfig(VALID_ENV).loginThrottle, { maxFailures: 5, lockMs: 15 * 60 * 1000 })
  })

  it('LOGIN_MAX_FAILURES · LOGIN_LOCK_MINUTES로 조정, 양의 정수가 아니면 실패', () => {
    assert.deepEqual(loadConfig({ ...VALID_ENV, LOGIN_MAX_FAILURES: '10', LOGIN_LOCK_MINUTES: '30' }).loginThrottle, {
      maxFailures: 10,
      lockMs: 30 * 60 * 1000,
    })
    for (const [key, bad] of [['LOGIN_MAX_FAILURES', '0'], ['LOGIN_LOCK_MINUTES', '-5'], ['LOGIN_MAX_FAILURES', '2.5']]) {
      assert.throws(() => loadConfig({ ...VALID_ENV, [key]: bad }), new RegExp(key))
    }
  })

  it('기본값: 프록시 신뢰 끔, 세션 7일', () => {
    const config = loadConfig(VALID_ENV)

    assert.equal(config.trustProxy, false)
    assert.equal(config.session.ttlMs, 7 * 24 * 60 * 60 * 1000)
  })

  it('TRUST_PROXY=true 이면 켜진다', () => {
    assert.equal(loadConfig({ ...VALID_ENV, TRUST_PROXY: 'true' }).trustProxy, true)
    assert.equal(loadConfig({ ...VALID_ENV, TRUST_PROXY: 'false' }).trustProxy, false)
  })

  it('TRUST_PROXY가 true/false가 아니면 실패한다', () => {
    assert.throws(() => loadConfig({ ...VALID_ENV, TRUST_PROXY: 'yes' }), /TRUST_PROXY/)
  })

  it('SESSION_TTL_DAYS로 세션 기간을 바꿀 수 있고, 양의 정수가 아니면 실패한다', () => {
    assert.equal(loadConfig({ ...VALID_ENV, SESSION_TTL_DAYS: '30' }).session.ttlMs, 30 * 24 * 60 * 60 * 1000)
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      assert.throws(() => loadConfig({ ...VALID_ENV, SESSION_TTL_DAYS: bad }), /SESSION_TTL_DAYS/)
    }
  })

  it('빠진 키가 여러 개면 모두 알려 준다', () => {
    const { KAKAO_CLIENT_SECRET, SESSION_SECRET, ...rest } = VALID_ENV

    assert.throws(() => loadConfig(rest), /SESSION_SECRET, .*KAKAO_CLIENT_SECRET|KAKAO_CLIENT_SECRET.*SESSION_SECRET/)
  })
})
