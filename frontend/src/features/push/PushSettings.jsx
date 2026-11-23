import { useEffect, useState } from 'react'
import {
  getPushStatus,
  enablePushNotifications,
  disablePushNotifications,
} from './pushApi'

export default function PushSettings() {
  const [status, setStatus] = useState('checking')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    getPushStatus()
      .then((result) => {
        if (active) setStatus(result)
      })
      .catch((err) => {
        if (active) {
          setStatus('error')
          setError(err.message)
        }
      })

    return () => { active = false }
  }, [])

  async function togglePush() {
    setBusy(true)
    setError('')
    setMessage('')

    try {
      if (status === 'enabled') {
        await disablePushNotifications()
        setStatus('disabled')
        setMessage('브라우저 푸시 알림을 껐습니다.')
      } else {
        await enablePushNotifications()
        setStatus('enabled')
        setMessage('브라우저 푸시 알림을 켰습니다.')
      }
    } catch (err) {
      setError(err.message)
      const next = await getPushStatus().catch(() => 'error')
      setStatus(next)
    } finally {
      setBusy(false)
    }
  }

  const enabled = status === 'enabled'
  const blocked = status === 'unsupported' || status === 'denied'

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">브라우저 푸시 알림</h3>

      <div className="settings-card" style={{ padding: '20px' }}>
        <p>
          {status === 'checking'
            ? '알림 상태를 확인하고 있어요.'
            : enabled
              ? '현재 브라우저에서 푸시 알림을 받고 있어요.'
              : status === 'denied'
                ? '브라우저 설정에서 알림 권한을 허용해 주세요.'
                : status === 'unsupported'
                  ? '현재 브라우저에서는 푸시 알림을 지원하지 않아요.'
                  : '알림을 켜면 새로운 학사 일정 소식을 받을 수 있어요.'}
        </p>

        <button
          type="button"
          className="cs-button is-primary"
          onClick={togglePush}
          disabled={busy || blocked || status === 'checking'}
          style={{ marginTop: '12px' }}
        >
          {busy
            ? '처리 중...'
            : enabled
              ? '푸시 알림 끄기'
              : '푸시 알림 켜기'}
        </button>

        {message && <p role="status" className="cs-message">{message}</p>}
        {error && <p role="alert" className="cs-error">{error}</p>}
      </div>
    </section>
  )
}
