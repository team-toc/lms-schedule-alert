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

  it('빠진 키가 여러 개면 모두 알려 준다', () => {
    const { KAKAO_CLIENT_SECRET, SESSION_SECRET, ...rest } = VALID_ENV

    assert.throws(() => loadConfig(rest), /SESSION_SECRET, .*KAKAO_CLIENT_SECRET|KAKAO_CLIENT_SECRET.*SESSION_SECRET/)
  })
})
