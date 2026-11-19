import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeEmail,
  maskEmail,
  validateSignupInput,
  validateLoginInput,
  EMAIL_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '../src/email/email-input.js'

const PASSWORD = 'correct horse battery staple'

function signupError(body) {
  const result = validateSignupInput(body)
  assert.ok(result.error, `에러가 나야 함: ${JSON.stringify(body)}`)
  return result.error
}

// 정확히 length자인 형식상 올바른 이메일: "a@" + 60자 라벨들(점으로 연결) + ".com"
const DOMAIN_LABEL_LENGTH = 60
function emailOfLength(length) {
  const prefix = 'a@'
  const tld = '.com'
  const labels = []
  let remaining = length - prefix.length - tld.length
  while (remaining > 0) {
    const size = Math.min(DOMAIN_LABEL_LENGTH, remaining)
    labels.push('b'.repeat(size))
    remaining -= size + 1 // 다음 라벨 앞의 점
  }
  if (remaining === 0) {
    // 마지막 라벨 뒤에 1자가 남았다(점 하나 자리): 그 라벨을 1자 늘려 길이를 맞춘다
    labels[labels.length - 1] += 'b'
  }
  return `${prefix}${labels.join('.')}${tld}`
}

describe('이메일 정규화 · 마스킹', () => {
  it('앞뒤 공백 제거 + 소문자', () => {
    assert.equal(normalizeEmail('  User.Name@Example.COM \t'), 'user.name@example.com')
  })

  it('마스킹: 로컬 파트 첫 글자만 남기고 도메인은 그대로', () => {
    assert.equal(maskEmail('young@example.com'), 'y***@example.com')
    assert.equal(maskEmail('a@example.com'), 'a***@example.com')
  })

  it('상수: 이메일 254자, 비밀번호 8 ~ 128자', () => {
    assert.deepEqual([EMAIL_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH], [254, 8, 128])
  })
})

describe('가입 입력 검증 (validateSignupInput)', () => {
  it('정상 입력: 이메일 정규화, 비밀번호는 그대로(공백 포함), displayName 그대로 넘김', () => {
    const result = validateSignupInput({ email: ' Me@Example.com ', password: ` ${PASSWORD} `, displayName: ' 홍길동 ' })

    assert.deepEqual(result, { value: { email: 'me@example.com', password: ` ${PASSWORD} `, displayName: ' 홍길동 ' } })
  })

  it('displayName은 선택 (없으면 null)', () => {
    assert.equal(validateSignupInput({ email: 'me@example.com', password: PASSWORD }).value.displayName, null)
  })

  const emailCases = [
    ['email 없음', {}, 'missing_email'],
    ['email 빈 문자열', { email: '' }, 'missing_email'],
    ['email 공백만', { email: '   ' }, 'missing_email'],
    ['email이 문자열이 아님', { email: 123 }, 'invalid_email'],
    ['@ 없음', { email: 'user.example.com' }, 'invalid_email'],
    ['@ 두 개', { email: 'a@b@example.com' }, 'invalid_email'],
    ['도메인에 점 없음', { email: 'user@localhost' }, 'invalid_email'],
    ['중간에 공백', { email: 'us er@example.com' }, 'invalid_email'],
    ['로컬 파트 없음', { email: '@example.com' }, 'invalid_email'],
    ['ASCII가 아님', { email: '사용자@example.com' }, 'invalid_email'],
    ['로컬 파트 65자', { email: `${'a'.repeat(65)}@example.com` }, 'invalid_email'],
    ['255자', { email: emailOfLength(EMAIL_MAX_LENGTH + 1) }, 'email_too_long'],
  ]
  for (const [label, emailPart, code] of emailCases) {
    it(`이메일 ${label} → ${code} (field: email)`, () => {
      assert.deepEqual(signupError({ password: PASSWORD, ...emailPart }), { code, field: 'email' })
    })
  }

  it('정확히 254자 이메일은 통과', () => {
    const email = emailOfLength(EMAIL_MAX_LENGTH)
    assert.equal(email.length, EMAIL_MAX_LENGTH)
    assert.equal(validateSignupInput({ email, password: PASSWORD }).value.email, email)
  })

  const passwordCases = [
    ['없음', {}, 'missing_password'],
    ['빈 문자열', { password: '' }, 'missing_password'],
    ['문자열이 아님', { password: 12345678 }, 'missing_password'],
    ['7자', { password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) }, 'password_too_short'],
    ['129자', { password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) }, 'password_too_long'],
    ['한글 129자(코드포인트)', { password: '가'.repeat(PASSWORD_MAX_LENGTH + 1) }, 'password_too_long'],
  ]
  for (const [label, passwordPart, code] of passwordCases) {
    it(`비밀번호 ${label} → ${code} (field: password)`, () => {
      assert.deepEqual(signupError({ email: 'me@example.com', ...passwordPart }), { code, field: 'password' })
    })
  }

  it('길이는 UTF-16이 아니라 코드포인트로 센다: 이모지 4개는 짧고, 이모지 128개는 통과', () => {
    assert.equal('😀'.repeat(4).length, 8, '테스트 전제: UTF-16으로는 8')
    assert.deepEqual(signupError({ email: 'me@example.com', password: '😀'.repeat(4) }), { code: 'password_too_short', field: 'password' })
    assert.ok(validateSignupInput({ email: 'me@example.com', password: '😀'.repeat(PASSWORD_MAX_LENGTH) }).value)
  })

  it('비밀번호 8자 · 128자는 통과, 이모지는 1자로 센다', () => {
    for (const password of ['a'.repeat(8), 'a'.repeat(128), '😀'.repeat(8)]) {
      assert.ok(validateSignupInput({ email: 'me@example.com', password }).value, password)
    }
  })

  describe('비밀번호 NFC 정규화 (ADR 0007)', () => {
    const HANGUL = '비밀번호한글'
    const nfd = (s) => s.normalize('NFD')

    it('NFD로 들어온 한글 비밀번호는 NFC로 바꿔서 돌려준다', () => {
      assert.notEqual(nfd(HANGUL), HANGUL, '테스트 전제: NFD와 NFC가 달라야 함')

      const { value } = validateSignupInput({ email: 'me@example.com', password: `${nfd(HANGUL)}12` })

      assert.equal(value.password, `${HANGUL}12`)
    })

    it('길이는 정규화한 뒤 센다: NFD 128글자(코드포인트 256개)는 NFC 128자라 통과', () => {
      const password = nfd('가'.repeat(PASSWORD_MAX_LENGTH))
      assert.equal([...password].length, PASSWORD_MAX_LENGTH * 2)

      assert.ok(validateSignupInput({ email: 'me@example.com', password }).value)
    })

    it('b) 정규화 후 128자를 넘으면 400 password_too_long (NFD 129글자)', () => {
      const password = nfd('가'.repeat(PASSWORD_MAX_LENGTH + 1))

      assert.deepEqual(signupError({ email: 'me@example.com', password }), { code: 'password_too_long', field: 'password' })
    })

    it('정규화 후 8자 미만이면 password_too_short (NFD 4글자 = 코드포인트 8개)', () => {
      const password = nfd('가나다라')
      assert.equal([...password].length, 8)

      assert.deepEqual(signupError({ email: 'me@example.com', password }), { code: 'password_too_short', field: 'password' })
    })

    it('로그인 입력도 NFC로 정규화하고, 상한은 정규화 후 기준', () => {
      assert.equal(validateLoginInput({ email: 'me@example.com', password: nfd(HANGUL) }).value.password, HANGUL)
      assert.ok(validateLoginInput({ email: 'me@example.com', password: nfd('가'.repeat(PASSWORD_MAX_LENGTH)) }).value)
    })
  })

  it('displayName이 문자열이 아니면 invalid_display_name (field: displayName)', () => {
    assert.deepEqual(signupError({ email: 'me@example.com', password: PASSWORD, displayName: 42 }), {
      code: 'invalid_display_name',
      field: 'displayName',
    })
  })

  it('여러 개가 틀리면 첫 번째(이메일 → 비밀번호 → 이름)만', () => {
    assert.deepEqual(signupError({ email: 'bad', password: '1', displayName: 1 }), { code: 'invalid_email', field: 'email' })
    assert.deepEqual(signupError({ email: 'me@example.com', password: '1', displayName: 1 }), {
      code: 'password_too_short',
      field: 'password',
    })
  })

  it('본문이 객체가 아니면(null · 배열) missing_email', () => {
    for (const body of [null, [], 'text']) {
      assert.deepEqual(signupError(body), { code: 'missing_email', field: 'email' })
    }
  })
})

describe('로그인 입력 검증 (validateLoginInput)', () => {
  it('정상 입력: 이메일 정규화, displayName은 받지 않음', () => {
    assert.deepEqual(validateLoginInput({ email: ' Me@Example.com', password: PASSWORD, displayName: 'x' }), {
      value: { email: 'me@example.com', password: PASSWORD },
    })
  })

  it('비밀번호 길이 하한은 검사하지 않는다 (틀린 비밀번호와 같은 401로 처리)', () => {
    assert.ok(validateLoginInput({ email: 'me@example.com', password: 'short' }).value)
  })

  it('비밀번호 상한(129자)은 검사한다 (해시 계산 비용 제한)', () => {
    assert.deepEqual(validateLoginInput({ email: 'me@example.com', password: 'a'.repeat(129) }).error, {
      code: 'password_too_long',
      field: 'password',
    })
  })

  it('이메일 형식 · 비밀번호 없음은 가입과 같은 코드', () => {
    assert.deepEqual(validateLoginInput({ email: 'bad', password: PASSWORD }).error, { code: 'invalid_email', field: 'email' })
    assert.deepEqual(validateLoginInput({ email: 'me@example.com' }).error, { code: 'missing_password', field: 'password' })
  })
})
