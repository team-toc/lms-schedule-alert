import { useCallback, useEffect, useState } from 'react'

// 공지에서 찾은 일정 제안 (백엔드 /api/suggestions, docs/api.md 기준)
// 수락하면 앱 일정(source: app)으로 만들어져 캘린더 · 홈에 나온다.

// 백엔드 suggestion-service.js 의 KIND_LABELS와 같은 값 (기본 제목 미리보기용)
const KIND_LABELS = {
  exam: '시험',
  cancellation: '휴강',
  makeup: '보강',
  deadline: '마감',
  other: '일정',
}

const DAY_MS = 86400000
const MAX_TITLE_CODE_POINTS = 255

const kindLabel = (kind) => KIND_LABELS[kind] ?? KIND_LABELS.other

// 수락할 때 본문을 비우면 서버가 만드는 제목: "종류: 공지 제목" (255자까지)
function defaultTitle(item) {
  return Array.from(`${kindLabel(item.kind)}: ${item.announcementTitle}`)
    .slice(0, MAX_TITLE_CODE_POINTS)
    .join('')
    .trim()
}

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

// 11/20(금)
function formatDay(value) {
  const { month, day, weekday } = seoulParts(value)
  return `${month}/${day}(${weekday})`
}

// 14:00
function formatClock(value) {
  const { hour, minute } = seoulParts(value)
  return `${hour}:${minute}`
}

// 하루 종일: endDate는 마지막 날 다음 날(미포함)이라 하루 빼서 보여 준다
function describeWhen(item) {
  if (item.isAllDay && item.startDate && item.endDate) {
    const start = Date.parse(`${item.startDate}T00:00:00+09:00`)
    const lastDay = Date.parse(`${item.endDate}T00:00:00+09:00`) - DAY_MS
    if (lastDay <= start) return `${formatDay(start)} 하루 종일`
    return `${formatDay(start)} ~ ${formatDay(lastDay)} 하루 종일`
  }

  return `${formatDay(item.startAt)} ${formatClock(item.startAt)} ~ ${formatClock(item.endAt)}`
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

export default function SuggestionList() {
  const [suggestions, setSuggestions] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  // status 기본값 pending: 아직 안 정했고 날짜가 안 지난 제안만
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiRequest('/api/suggestions')
      setSuggestions(data.suggestions ?? [])
      setNextCursor(data.nextCursor ?? null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function loadMore() {
    if (!nextCursor || busy) return

    setBusy(true)
    setError('')

    try {
      const params = new URLSearchParams({ cursor: nextCursor })
      const data = await apiRequest(`/api/suggestions?${params}`)
      setSuggestions((items) => [...items, ...(data.suggestions ?? [])])
      setNextCursor(data.nextCursor ?? null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function accept(item) {
    const title = defaultTitle(item)
    const when = describeWhen(item)
    if (!window.confirm(`아래 일정을 캘린더에 추가할까요?\n\n${title}\n${when}`)) return

    setBusy(true)
    setError('')
    setMessage('')

    try {
      // 빈 본문이면 제안 값 그대로 앱 일정이 만들어진다
      await apiRequest(`/api/suggestions/${item.id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      setMessage(`'${title}' 일정을 캘린더에 추가했어요. (${when})`)
    } catch (err) {
      // 이미 처리됨 · 만료(409), 없음(404) 등은 서버 문구를 보여 주고 목록을 다시 읽는다
      setError(err.message)
    } finally {
      await load()
      setBusy(false)
    }
  }

  async function reject(item) {
    if (!window.confirm(`'${item.announcementTitle}' 제안을 거절할까요?\n거절한 날짜는 다시 제안되지 않아요.`)) return

    setBusy(true)
    setError('')
    setMessage('')

    try {
      await apiRequest(`/api/suggestions/${item.id}/reject`, { method: 'POST' })
      setMessage('제안을 거절했어요.')
    } catch (err) {
      setError(err.message)
    } finally {
      await load()
      setBusy(false)
    }
  }

  return (
    <section className="noti-section" aria-label="공지 일정 제안">
      <h2 className="noti-section-title">
        일정 제안 <span className="noti-section-count">{loading ? '' : suggestions.length}</span>
      </h2>

      {message && <p role="status" className="noti-desc">{message}</p>}
      {error && <p role="alert" className="noti-error">{error}</p>}

      <div className="noti-card">
        {loading ? (
          <p className="noti-empty">일정 제안을 불러오는 중...</p>
        ) : suggestions.length === 0 ? (
          <p className="noti-empty">공지에서 찾은 새 일정 제안이 없어요.</p>
        ) : (
          <ul className="noti-list">
            {suggestions.map((item) => (
              <li className="noti-change" key={item.id}>
                <div className="noti-change-top">
                  <span className="noti-badges">
                    <span className="noti-badge is-new">{kindLabel(item.kind)}</span>
                    {item.courseName && (
                      <span className="noti-badge is-course">{item.courseName}</span>
                    )}
                  </span>
                </div>

                <strong className="noti-change-title">{defaultTitle(item)}</strong>

                <p className="noti-compare" title={describeWhen(item)}>
                  <b>{describeWhen(item)}</b>
                </p>

                {item.context && (
                  <p className="noti-compare" title={item.context}>
                    공지 내용: {item.context}
                  </p>
                )}

                <div className="noti-actions">
                  <button
                    type="button"
                    className="noti-button is-primary"
                    onClick={() => accept(item)}
                    disabled={busy}
                  >
                    캘린더에 추가
                  </button>
                  <button
                    type="button"
                    className="noti-button"
                    onClick={() => reject(item)}
                    disabled={busy}
                  >
                    거절
                  </button>
                  {isLmsUrl(item.url) && (
                    <a
                      className="noti-button"
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      공지 보기
                    </a>
                  )}
                </div>
              </li>
            ))}
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
  )
}
