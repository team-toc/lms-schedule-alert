import { useEffect, useState } from 'react'
import './CanvasSettings.css'

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
  })

  const data = response.status === 204
    ? {}
    : await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.message || `요청 실패 (${response.status})`)
  }

  return data
}

// 서버의 status 값을 화면 문구로 변환 (알 수 없는 값은 성공으로 처리하지 않음)
function describeStatus(status) {
  if (status === null) {
    return { label: '확인 중', tone: 'neutral', description: '연결 상태를 확인하고 있어요.' }
  }

  switch (status.status) {
    case 'not_connected':
      return {
        label: '연결 안 됨',
        tone: 'neutral',
        description: 'Canvas 액세스 토큰을 등록하면 LMS 과제와 일정을 불러와요.',
      }
    case 'connected':
    case 'ok':
      return { label: '연결됨', tone: 'success', description: 'Canvas LMS와 연결되어 있어요.' }
    case 'syncing':
      return { label: '동기화 중', tone: 'info', description: 'Canvas 데이터를 동기화하고 있어요.' }
    case 'failing':
      return {
        label: '동기화 실패',
        tone: 'warning',
        description: 'Canvas 연결이 잠시 안 돼요. 자동으로 다시 시도하며, 그동안 마지막으로 불러온 자료를 보여드려요.',
      }
    case 'needs_reauth':
      return {
        label: '토큰 재등록 필요',
        tone: 'warning',
        description: '토큰을 다시 등록해야 해요. 새 토큰을 발급받아 갱신해 주세요.',
      }
    default:
      return {
        label: status.status ?? '확인 필요',
        tone: 'neutral',
        description: '연결 상태를 확인할 수 없어요.',
      }
  }
}

export default function CanvasSettings() {
  const [status, setStatus] = useState(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function refresh() {
    const data = await request('/api/lms/status')
    setStatus(data)
  }

  useEffect(() => {
    let active = true

    request('/api/lms/status')
      .then((data) => {
        if (active) setStatus(data)
      })
      .catch((err) => {
        if (active) setError(err.message)
      })

    return () => { active = false }
  }, [])

  async function perform(action) {
    setBusy(true)
    setError('')
    setMessage('')

    try {
      if (action === 'register') {
        if (!token.trim()) {
          throw new Error('Canvas 토큰을 입력해 주세요.')
        }

        await request('/api/lms/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token.trim() }),
        })

        setToken('')
        setMessage('토큰 등록 성공! 동기화를 시작했습니다.')
      }

      if (action === 'sync') {
        await request('/api/lms/sync', { method: 'POST' })
        setMessage('동기화를 요청했습니다. 잠시 후 상태를 새로고침해 주세요.')
      }

      if (action === 'delete') {
        if (!window.confirm('Canvas 연결을 해제할까요?')) return

        await request('/api/lms/token', { method: 'DELETE' })
        setToken('')
        setMessage('Canvas 연결을 해제했습니다.')
      }

      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const connected = status && status.status !== 'not_connected'

  // 첫 상태 조회가 실패하면 '확인 중'에 머무르지 않고 실패를 표시
  const statusInfo = status === null && error
    ? {
        label: '확인 실패',
        tone: 'warning',
        description: '연결 상태를 불러오지 못했어요. 연결 상태 새로고침을 눌러 주세요.',
      }
    : describeStatus(status)

  return (
    <section className="canvas-settings">
      <div className="cs-head">
        <h3 className="cs-title">Canvas LMS 연동</h3>
        <button
          type="button"
          className="cs-text-button"
          onClick={() => {
            setError('')
            refresh().catch((err) => setError(err.message))
          }}
        >
          연결 상태 새로고침
        </button>
      </div>

      <div className="cs-card">
        <div className="cs-status">
          <span className={`cs-badge is-${statusInfo.tone}`}>
            <i aria-hidden="true" />
            {statusInfo.label}
          </span>
          <p className="cs-status-desc">{statusInfo.description}</p>
        </div>

        <div className="cs-form">
          <label className="cs-label" htmlFor="canvas-token">
            Canvas 액세스 토큰
          </label>

          <input
            id="canvas-token"
            className="cs-input"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="발급받은 토큰 붙여넣기"
            autoComplete="off"
            maxLength={200}
          />

          <button
            type="button"
            className="cs-button is-primary"
            disabled={busy}
            onClick={() => perform('register')}
          >
            {connected ? '토큰 갱신' : 'Canvas 연결'}
          </button>

          <div className="cs-actions">
            <button
              type="button"
              className="cs-button"
              disabled={busy || !connected}
              onClick={() => perform('sync')}
            >
              지금 동기화
            </button>

            <button
              type="button"
              className="cs-button is-danger"
              disabled={busy || !connected}
              onClick={() => perform('delete')}
            >
              연결 해제
            </button>
          </div>

          {message && <p role="status" className="cs-message">{message}</p>}
          {error && <p role="alert" className="cs-error">{error}</p>}
        </div>

        <p className="cs-notice">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8h.01" />
          </svg>
          <span>
            인하공전 Canvas 토큰은 최대 7일간 유효합니다.
            만료되면 새 토큰을 발급받아 갱신해 주세요.
          </span>
        </p>
      </div>
    </section>
  )
}
