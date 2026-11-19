import { useEffect, useState } from 'react'
import clockLogo from './assets/toc-clock-logo.png'
import './HomeDashboard.css'

const TIME_ZONE = 'Asia/Seoul'
const DAY_MS = 86400000

// 일정 변경으로 취급할 알림 종류 (NotificationList.jsx의 KIND_LABELS 기준)
const CHANGE_KINDS = [
  'assignment_due_changed',
  'assignment_title_changed',
  'assignment_removed',
]

const seoulDate = (value) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))

function seoulParts(value) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: TIME_ZONE,
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

// 13:00
function formatClock(value) {
  const { hour, minute } = seoulParts(value)
  return `${hour}:${minute}`
}

// 11/4(수) 23:59
function formatDue(value) {
  if (!value) return '미지정'
  const { month, day, weekday, hour, minute } = seoulParts(value)
  return `${month}/${day}(${weekday}) ${hour}:${minute}`
}

function getDdayDays(dueAt, today) {
  const due = seoulDate(dueAt)
  return Math.round((Date.parse(due) - Date.parse(today)) / DAY_MS)
}

function getDday(dueAt, today) {
  const days = getDdayDays(dueAt, today)

  if (days === 0) return 'D-DAY'
  if (days > 0) return `D-${days}`
  return `D+${Math.abs(days)}`
}

function getDueTone(days) {
  if (days <= 1) return 'urgent'
  if (days <= 3) return 'soon'
  return 'normal'
}

// 오늘부터 7일 (한국 시간 기준)
function buildWeek(today) {
  const start = Date.parse(`${today}T00:00:00+09:00`)

  return Array.from({ length: 7 }, (_, index) => {
    const timestamp = start + index * DAY_MS
    const { month, day, weekday } = seoulParts(timestamp)
    return { date: seoulDate(timestamp), month, day, weekday }
  })
}

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
      before: formatDue(before),
      after: formatDue(after),
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

function ChangeBanner({ changes, hasMore, error, onOpen }) {
  const latest = changes[0]
  const content = latest ? describeChange(latest) : null
  const countLabel = `${changes.length}${hasMore ? '+' : ''}`

  return (
    <button
      type="button"
      className={`home-banner${latest ? ' has-change' : ''}`}
      onClick={onOpen}
      disabled={!onOpen}
    >
      <span className="home-banner-text">
        {error ? (
          <>
            <span className="home-banner-eyebrow">일정 변경</span>
            <span className="home-banner-headline">
              변경 알림을 불러오지 못했어요
            </span>
            <span className="home-banner-detail">{error}</span>
          </>
        ) : latest ? (
          <>
            <span className="home-banner-eyebrow">
              확인 안 한 변경 {countLabel}건
            </span>
            <span className="home-banner-headline">{content.headline}</span>
            <span className="home-banner-detail">
              {latest.courseName && <>{latest.courseName} · </>}
              {content.before !== null && (
                <>
                  <s>{content.before}</s> → <b>{content.after}</b>
                </>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="home-banner-eyebrow">일정 변경</span>
            <span className="home-banner-headline">
              새로 바뀐 일정이 없어요
            </span>
            <span className="home-banner-detail">
              LMS에서 변경이 감지되면 여기에 알려드려요
            </span>
          </>
        )}
      </span>

      <img className="home-banner-art" src={clockLogo} alt="" />
    </button>
  )
}

export default function HomeDashboard({ onOpenCalendar, onOpenNotifications }) {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [changes, setChanges] = useState([])
  const [changesHasMore, setChangesHasMore] = useState(false)
  const [changesError, setChangesError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function load() {
      try {
        const today = seoulDate(new Date())

        const end = new Date(`${today}T00:00:00+09:00`)
        end.setUTCDate(end.getUTCDate() + 31)

        const from = `${today}T00:00:00+09:00`
        const to = end.toISOString()

        const params = new URLSearchParams({ from, to })

        const response = await fetch(
          `/api/calendar/events?${params}`,
          {
            credentials: 'include',
            signal: controller.signal,
          }
        )

        if (!response.ok) {
          throw new Error(`일정 조회 실패 (${response.status})`)
        }

        const data = await response.json()

        if (!controller.signal.aborted) {
          setEvents(data.events ?? [])
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          setError(err.message)
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    load()

    return () => controller.abort()
  }, [])

  // 일정 변경 배너: 기존 /api/notifications 를 읽기만 함 (읽음 처리는 알림 탭에서)
  useEffect(() => {
    const controller = new AbortController()

    async function loadChanges() {
      try {
        const response = await fetch('/api/notifications?unread=true', {
          credentials: 'include',
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`알림 조회 실패 (${response.status})`)
        }

        const data = await response.json()

        if (!controller.signal.aborted) {
          setChanges(
            (data.notifications ?? []).filter((item) =>
              CHANGE_KINDS.includes(item.kind)
            )
          )
          setChangesHasMore(Boolean(data.nextCursor))
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          setChangesError(err.message)
        }
      }
    }

    loadChanges()

    return () => controller.abort()
  }, [])

  const today = seoulDate(new Date())
  const week = buildWeek(today)

  const todayEvents = events
    .filter((event) => {
      if (event.isAllDay && event.startDate && event.endDate) {
        return event.startDate <= today && today < event.endDate
      }
      const time = event.dueAt ?? event.startAt
      return time && seoulDate(time) === today
    })
    .sort(
      (a, b) =>
        new Date(a.dueAt ?? a.startAt) - new Date(b.dueAt ?? b.startAt)
    )

  const upcomingAll = events
    .filter((event) => event.source === 'assignment' && event.dueAt)
    .filter((event) => new Date(event.dueAt) >= new Date())
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))

  const upcoming = upcomingAll.slice(0, 5)

  const dueCountByDate = upcomingAll.reduce((counts, event) => {
    const date = seoulDate(event.dueAt)
    counts[date] = (counts[date] ?? 0) + 1
    return counts
  }, {})

  const weekDueCount = week.reduce(
    (sum, day) => sum + (dueCountByDate[day.date] ?? 0),
    0
  )

  if (loading) {
    return (
      <div className="home-dashboard">
        <p className="home-status">일정을 불러오는 중...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="home-dashboard">
        <p className="home-status" role="alert">{error}</p>
      </div>
    )
  }

  return (
    <div className="home-dashboard">
      <ChangeBanner
        changes={changes}
        hasMore={changesHasMore}
        error={changesError}
        onOpen={onOpenNotifications}
      />

      <section className="home-section">
        <div className="home-section-head">
          <h2 className="home-section-title">
            오늘 <span className="home-section-count">{todayEvents.length}</span>
          </h2>
          {onOpenCalendar && (
            <button
              type="button"
              className="home-section-link"
              onClick={onOpenCalendar}
            >
              캘린더
              <span aria-hidden="true" className="home-chevron" />
            </button>
          )}
        </div>

        <div className="home-card">
          {todayEvents.length === 0 ? (
            <p className="home-empty">오늘 등록된 일정이 없습니다.</p>
          ) : (
            <ul className="home-today-list">
              {todayEvents.map((event) => (
                <li
                  className="home-today-item"
                  key={`${event.source}-${event.id}`}
                >
                  <span className="home-today-time">
                    {event.isAllDay ? '종일' : formatClock(event.dueAt ?? event.startAt)}
                  </span>
                  <span className="home-today-body">
                    <strong className="home-item-title">{event.title}</strong>
                    <span className="home-item-sub">
                      {event.courseName ?? '개인 일정'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h2 className="home-section-title">
            다가오는 마감{' '}
            <span className="home-section-count">{upcomingAll.length}</span>
          </h2>
        </div>

        <div className="home-card">
          <ol className="home-week" aria-label="이번 주 마감">
            {week.map((day, index) => {
              const count = dueCountByDate[day.date] ?? 0
              const classNames = ['home-week-day']
              if (index === 0) classNames.push('is-today')
              if (day.weekday === '토') classNames.push('is-sat')
              if (day.weekday === '일') classNames.push('is-sun')

              return (
                <li className={classNames.join(' ')} key={day.date}>
                  <span className="home-week-label">
                    {index === 0 ? '오늘' : day.weekday}
                  </span>
                  <span className="home-week-num">{day.day}</span>
                  <span
                    className="home-week-dots"
                    aria-label={count ? `마감 ${count}개` : undefined}
                  >
                    {Array.from({ length: Math.min(count, 3) }, (_, i) => (
                      <i key={i} />
                    ))}
                  </span>
                </li>
              )
            })}
          </ol>

          <div className="home-week-meta">
            <span>이번 주 마감 {weekDueCount}개</span>
            <span>
              {week[0].month}.{week[0].day} – {week[6].month}.{week[6].day}
            </span>
          </div>

          {upcoming.length === 0 ? (
            <p className="home-empty">예정된 과제가 없습니다.</p>
          ) : (
            <ul className="home-due-list">
              {upcoming.map((event) => {
                const tone = getDueTone(getDdayDays(event.dueAt, today))

                return (
                  <li
                    className="home-due-item"
                    key={`${event.source}-${event.id}`}
                  >
                    <span className="home-due-body">
                      <strong className="home-item-title">{event.title}</strong>
                      <span className="home-item-sub">
                        {event.courseName} · {formatDue(event.dueAt)}
                      </span>
                    </span>
                    <span className={`home-dday is-${tone}`}>
                      {getDday(event.dueAt, today)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
