import { useEffect, useState } from 'react'

const seoulDate = (value) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))

function formatTime(value) {
  return new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getDday(dueAt, today) {
  const due = seoulDate(dueAt)
  const days = Math.round(
    (Date.parse(due) - Date.parse(today)) / 86400000
  )

  if (days === 0) return 'D-DAY'
  if (days > 0) return `D-${days}`
  return `D+${Math.abs(days)}`
}

export default function HomeDashboard() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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

  const today = seoulDate(new Date())

  const todayEvents = events.filter((event) => {
    const time = event.dueAt ?? event.startAt
    return time && seoulDate(time) === today
  })

  const upcoming = events
    .filter((event) => event.source === 'assignment' && event.dueAt)
    .filter((event) => new Date(event.dueAt) >= new Date())
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
    .slice(0, 5)

  if (loading) return <p>일정을 불러오는 중...</p>
  if (error) return <p role="alert">{error}</p>

  return (
    <>
      <section className="panel">
        <h3>오늘 일정</h3>

        {todayEvents.length === 0 ? (
          <p>오늘 등록된 일정이 없습니다.</p>
        ) : (
          todayEvents.map((event) => (
            <div key={`${event.source}-${event.id}`}
              style={{ padding: '10px 0', borderBottom: '1px solid #eee' }}>
              <strong>{event.title}</strong>
              <p>
                {event.courseName ?? '개인 일정'} ·{' '}
                {formatTime(event.dueAt ?? event.startAt)}
              </p>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h3>다가오는 과제 마감</h3>

        {upcoming.length === 0 ? (
          <p>예정된 과제가 없습니다.</p>
        ) : (
          upcoming.map((event) => (
            <div key={event.id}
              style={{ padding: '10px 0', borderBottom: '1px solid #eee' }}>
              <strong>{event.title}</strong>
              <p>{event.courseName} · {formatTime(event.dueAt)}</p>
              <strong style={{ color: '#2563eb' }}>
                {getDday(event.dueAt, today)}
              </strong>
            </div>
          ))
        )}
      </section>
    </>
  )
}
