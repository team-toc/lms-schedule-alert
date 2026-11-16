import { useEffect, useState } from 'react'

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

  return (
    <div>
      <h3>Canvas LMS 연동</h3>

      <p>
        연결 상태: <strong>
          {status === null
            ? '확인 중'
            : status.status === 'not_connected'
              ? '연결 안 됨'
              : status.status === 'connected'
                ? '연결됨'
                : status.status === 'syncing'
                  ? '동기화 중'
                  : status.status === 'needs_reauth'
                    ? '토큰 재등록 필요'
                    : status.status ?? '확인 필요'}
        </strong>
      </p>

      <button type="button" onClick={() => {
        setError('')
        refresh().catch((err) => setError(err.message))
      }}>
        연결 상태 새로고침
      </button>

      <div style={{ marginTop: 20, display: 'grid', gap: 10, maxWidth: 450 }}>
        <label htmlFor="canvas-token">
          Canvas 액세스 토큰
        </label>

        <input
          id="canvas-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="발급받은 토큰 붙여넣기"
          autoComplete="off"
          maxLength={200}
          style={{ padding: 10, width: '100%', boxSizing: 'border-box' }}
        />

        <button type="button" disabled={busy}
          onClick={() => perform('register')}>
          {connected ? '토큰 갱신' : 'Canvas 연결'}
        </button>

        <button type="button" disabled={busy || !connected}
          onClick={() => perform('sync')}>
          지금 동기화
        </button>

        <button type="button" disabled={busy || !connected}
          onClick={() => perform('delete')}>
          연결 해제
        </button>
      </div>

      <p style={{ color: '#6b7280' }}>
        인하공전 Canvas 토큰은 최대 7일간 유효합니다.
        만료되면 새 토큰을 발급받아 갱신해 주세요.
      </p>

      {message && <p role="status">{message}</p>}
      {error && <p role="alert" style={{ color: '#dc2626' }}>{error}</p>}
    </div>
  )
}
