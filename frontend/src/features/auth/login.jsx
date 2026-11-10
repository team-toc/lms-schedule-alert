import { useState } from 'react'
import { login } from './authApi'
import './login.css'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function Login({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()

    if (!email.trim() || !password) {
      setError('이메일과 비밀번호를 입력해 주세요.')
      return
    }

    if (!EMAIL_PATTERN.test(email.trim())) {
      setError('이메일 형식이 올바르지 않습니다.')
      return
    }

    setError('')
    setIsSubmitting(true)

    const result = await login(email.trim(), password)

    setIsSubmitting(false)

    if (!result.ok) {
      setError(result.message)
      return
    }

    onLogin(result.user)
  }

  return (
    <div className="login">
      <div className="login-card">
        <h1 className="login-title">TOC</h1>
        <p className="login-subtitle">나의 학사 일정 관리</p>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <label className="login-label" htmlFor="login-email">
            이메일
          </label>
          <input
            id="login-email"
            className="login-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="example@school.ac.kr"
            autoComplete="email"
          />

          <label className="login-label" htmlFor="login-password">
            비밀번호
          </label>
          <input
            id="login-password"
            className="login-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="비밀번호"
            autoComplete="current-password"
          />

          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="login-button"
            disabled={isSubmitting}
          >
            {isSubmitting ? '로그인 중...' : '로그인'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Login