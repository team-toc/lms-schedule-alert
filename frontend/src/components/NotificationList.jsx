import { useCallback, useEffect, useState } from 'react'
import SuggestionList from './SuggestionList'
import './NotificationList.css'

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

const CHANGE_KINDS = [
  'assignment_due_changed',
  'assignment_title_changed',
  'assignment_removed',
]

const BADGE_LABELS = {
  assignment_created: '새 과제',
  assignment_due_changed: '마감 변경',
  assignment_title_changed: '제목 변경',
  assignment_removed: '과제 삭제',
  announcement_created: '새 공지',
  announcement_updated: '공지 수정',
}

const DAY_MS = 86400000

const seoulDate = (value) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))

function seoulParts(value) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value))

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  )
}

// 11/4(수) 23:59
function formatShort(value) {
  if (!value) return '미지정'
  const { month, day, weekday, hour, minute } = seoulParts(value)
  return `${month}/${day}(${weekday}) ${hour}:${minute}`
}

// 방금 · N분 전 · N시간 전 · 어제 · N일 전 · 11/4(수) 23:59
function formatRelative(value) {
  if (!value) return ''
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000)
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  const days = Math.round(
    (Date.parse(seoulDate(Date.now())) - Date.parse(seoulDate(value))) / DAY_MS
  )
  if (days <= 1) return '어제'
  if (days < 7) return `${days}일 전`
  return formatShort(value)
}

// 확인 필요 카드의 제목과 변경 전후 비교
function describeChange(item) {
  if (item.kind === 'assignment_due_changed') {
    const before = item.before?.dueAt
    const after = item.after?.dueAt
    let verb = '바뀌었어요'

    if (before && after) {
      const diff = new Date(after) - new Date(before)
      if (diff < 0) verb = '앞당겨졌어요'
      if (diff > 0) verb = '미뤄졌어요'
    }

    return {
      headline: `${item.title} 마감이 ${verb}`,
      before: formatShort(before),
      after: formatShort(after),
    }
  }

  if (item.kind === 'assignment_title_changed') {
    return {
      headline: '과제 제목이 바뀌었어요',
      before: item.before?.title ?? '이전 제목 없음',
      after: item.after?.title ?? '현재 제목 없음',
    }
  }

  return {
    headline: `${item.title} 과제가 삭제됐어요`,
    before: null,
    after: null,
  }
}

// 새 소식 목록의 보조 설명
function newsSummary(item) {
  let detail = ''

  if (item.kind === 'assignment_created' && item.after?.dueAt) {
    detail = `마감 ${formatShort(item.after.dueAt)}`
  } else if (CHANGE_KINDS.includes(item.kind)) {
    detail = changeDescription(item)
  }

  return [item.courseName, detail].filter(Boolean).join(' · ')
}

const isLmsUrl = (url) => Boolean(url) && /^https:\/\//.test(url)

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
      const query = onlyUnread ? '?unread=true' : '';
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
      if (unreadOnly) params.set('unread', 'true')

      const data = await apiRequest(`/api/notifications?${params}`)
      setNotifications((items) => [...items, ...(data.notifications ?? [])])
      setNextCursor(data.nextCursor ?? null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const changes = notifications.filter(
    (item) => !item.read && CHANGE_KINDS.includes(item.kind)
  )
  const news = notifications.filter(
    (item) => item.read || !CHANGE_KINDS.includes(item.kind)
  )

  return (
    <div className="notification-view">
      <div className="noti-header">
        <h2 className="noti-title">알림</h2>
        <p className="noti-desc">LMS에서 바뀐 일정과 새 소식을 모아 보여드려요</p>
      </div>

      <div className="noti-toolbar">
        <label className={`noti-chip${unreadOnly ? ' is-on' : ''}`}>
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />
          안 읽은 알림만
        </label>

        <span className="noti-toolbar-actions">
          <button
            type="button"
            className="noti-text-button"
            onClick={markAllRead}
            disabled={loading || busy}
          >
            전체 읽음
          </button>
          <button
            type="button"
            className="noti-text-button"
            onClick={() => load()}
            disabled={loading || busy}
          >
            새로고침
          </button>
        </span>
      </div>

      {error && <p role="alert" className="noti-error">{error}</p>}

      <SuggestionList />

      <section className="noti-section">
        <h2 className="noti-section-title">
          확인 필요 <span className="noti-section-count">{loading ? '' : changes.length}</span>
        </h2>

        <div className="noti-card">
          {loading ? (
            <p className="noti-empty">알림을 불러오는 중...</p>
          ) : changes.length === 0 ? (
            <p className="noti-empty">확인할 일정 변경이 없어요.</p>
          ) : (
            <ul className="noti-list">
              {changes.map((item) => {
                const change = describeChange(item)

                return (
                  <li className="noti-change" key={item.id}>
                    <div className="noti-change-top">
                      <span className="noti-badges">
                        <span
                          className="noti-badge is-change"
                          title={KIND_LABELS[item.kind] ?? item.kind}
                        >
                          {BADGE_LABELS[item.kind] ?? item.kind}
                        </span>
                        {item.courseName && (
                          <span className="noti-badge is-course">{item.courseName}</span>
                        )}
                      </span>
                      <time
                        className="noti-time"
                        dateTime={item.detectedAt}
                        title={formatDate(item.detectedAt)}
                      >
                        {formatRelative(item.detectedAt)}
                      </time>
                    </div>

                    <strong className="noti-change-title">{change.headline}</strong>

                    {change.before !== null && (
                      <p className="noti-compare">
                        <s>{change.before}</s>
                        <span aria-hidden="true"> → </span>
                        <b>{change.after}</b>
                      </p>
                    )}

                    <div className="noti-actions">
                      <button
                        type="button"
                        className="noti-button is-primary"
                        onClick={() => markRead(item.id)}
                        disabled={busy}
                      >
                        읽음 처리
                      </button>
                      {isLmsUrl(item.url) && (
                        <a
                          className="noti-button"
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          LMS에서 보기
                        </a>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="noti-section">
        <h2 className="noti-section-title">
          새 소식 <span className="noti-section-count">{loading ? '' : news.length}</span>
        </h2>

        <div className="noti-card">
          {loading ? (
            <p className="noti-empty">알림을 불러오는 중...</p>
          ) : news.length === 0 ? (
            <p className="noti-empty">
              {unreadOnly ? '안 읽은 새 소식이 없어요.' : '새 소식이 없어요.'}
            </p>
          ) : (
            <ul className="noti-list">
              {news.map((item) => {
                const content = (
                  <>
                    <span className="noti-news-line">
                      <span
                        className={`noti-badge ${CHANGE_KINDS.includes(item.kind) ? 'is-change' : 'is-new'}`}
                        title={KIND_LABELS[item.kind] ?? item.kind}
                      >
                        {BADGE_LABELS[item.kind] ?? item.kind}
                      </span>
                      <strong className="noti-news-title">{item.title}</strong>
                    </span>
                    <span className="noti-news-sub">{newsSummary(item)}</span>
                  </>
                )

                return (
                  <li
                    className={`noti-news${item.read ? ' is-read' : ''}`}
                    key={item.id}
                  >
                    {isLmsUrl(item.url) ? (
                      <a
                        className="noti-news-body"
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${item.title} - LMS에서 보기`}
                      >
                        {content}
                      </a>
                    ) : (
                      <span className="noti-news-body">{content}</span>
                    )}

                    <span className="noti-news-side">
                      <time
                        className="noti-time is-strong"
                        dateTime={item.detectedAt}
                        title={formatDate(item.detectedAt)}
                      >
                        {formatRelative(item.detectedAt)}
                      </time>
                      {!item.read && (
                        <button
                          type="button"
                          className="noti-read-button"
                          onClick={() => markRead(item.id)}
                          disabled={busy}
                        >
                          읽음
                        </button>
                      )}
                    </span>

                    {isLmsUrl(item.url) && (
                      <span className="noti-chevron" aria-hidden="true" />
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {!loading && nextCursor && (
            <button
              type="button"
              className="noti-more"
              onClick={loadMore}
              disabled={busy}
            >
              더 보기
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
