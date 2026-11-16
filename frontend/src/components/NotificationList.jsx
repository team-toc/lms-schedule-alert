import { useCallback, useEffect, useState } from 'react'

const KIND_LABELS = {
  assignment_created: '새 과제',
  assignment_due_changed: '과제 마감 변경',
  assignment_title_changed: '과제 제목 변경',
  assignment_removed: '과제 삭제',
  announcement_created: '새 공지',
  announcement_updated: '공지 수정',
}

function formatDate(value) {
  if (!value) return '미지정'
  return new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
  })
}

function changeDescription(item) {
  if (item.kind === 'assignment_due_changed') {
    return `마감 변경: ${formatDate(item.before?.dueAt)} → ${formatDate(item.after?.dueAt)}`
  }

  if (
    item.kind === 'assignment_title_changed' ||
    item.kind === 'announcement_updated'
  ) {
    if (item.before?.title || item.after?.title) {
      return `${item.before?.title ?? '이전 제목 없음'} → ${item.after?.title ?? '현재 제목 없음'}`
    }
  }

  if (item.kind === 'assignment_created') {
    return `마감: ${formatDate(item.after?.dueAt)}`
  }

  return `감지: ${formatDate(item.detectedAt)}`
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.message || `요청 실패 (${response.status})`)
  }

  return response.status === 204 ? null : response.json()
}

export default function NotificationList() {
  const [notifications, setNotifications] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)

  const load = useCallback(async (onlyUnread = unreadOnly) => {
    setLoading(true)
    setError('')

    try {
      const query = onlyUnread ? '?unreadOnly=true' : ''
      const data = await apiRequest(`/api/notifications${query}`)

      setNotifications(data.notifications ?? [])
      setNextCursor(data.nextCursor ?? null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [unreadOnly])

  useEffect(() => {
    load()
  }, [load])

  async function markRead(id) {
    setBusy(true)
    setError('')

    try {
      await apiRequest(`/api/notifications/${id}/read`, {
        method: 'POST',
      })
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function markAllRead() {
    setBusy(true)
    setError('')

    try {
      await apiRequest('/api/notifications/read-all', {
        method: 'POST',
      })
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function loadMore() {
    if (!nextCursor || busy) return

    setBusy(true)
    setError('')

    try {
      const params = new URLSearchParams({ cursor: nextCursor })
      if (unreadOnly) params.set('unreadOnly', 'true')

      const data = await apiRequest(`/api/notifications?${params}`)
      setNotifications((items) => [...items, ...(data.notifications ?? [])])
      setNextCursor(data.nextCursor ?? null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2>최근 알림</h2>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button type="button" onClick={() => load()} disabled={loading || busy}>
          새로고침
        </button>

        <button type="button" onClick={markAllRead} disabled={loading || busy}>
          전체 읽음
        </button>

        <label>
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />
          안 읽은 알림만
        </label>
      </div>

      {loading && <p>알림을 불러오는 중...</p>}
      {error && <p role="alert" style={{ color: '#dc2626' }}>{error}</p>}

      {!loading && notifications.length === 0 && (
        <p>새로운 알림이 없습니다.</p>
      )}

      {!loading && notifications.map((item) => (
        <div
          className="notification-item"
          key={item.id}
          style={{
            padding: 12,
            marginBottom: 8,
            borderLeft: item.read ? '3px solid #d1d5db' : '3px solid #2563eb',
            opacity: item.read ? 0.75 : 1,
          }}
        >
          <strong>
            [{KIND_LABELS[item.kind] ?? item.kind}] {item.title}
          </strong>

          <p>{item.courseName}</p>
          <p>{changeDescription(item)}</p>

          <small>{formatDate(item.detectedAt)}</small>

          <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
            {!item.read && (
              <button type="button" onClick={() => markRead(item.id)} disabled={busy}>
                읽음 처리
              </button>
            )}

            {item.url && /^https:\/\//.test(item.url) && (
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                LMS에서 보기
              </a>
            )}
          </div>
        </div>
      ))}

      {!loading && nextCursor && (
        <button type="button" onClick={loadMore} disabled={busy}>
          더 보기
        </button>
      )}
    </section>
  )
}
