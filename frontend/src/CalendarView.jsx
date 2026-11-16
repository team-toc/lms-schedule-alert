import ScheduleManager from './ScheduleManager'
import { useEffect, useState } from 'react'
import './CalendarView.css'

const seoulDate = (value) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))

const timeInSeoul = (value) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

// 응답의 source 값으로 확인 가능한 구분만 사용: assignment(과제 마감), app(개인 일정)
// 그 외 source가 오면 '기타'로 표시 (수업·변경됨은 구분할 데이터가 없어 사용하지 않음)
const CATEGORY_ORDER = ['due', 'mine', 'other']
const CATEGORY_LABELS = { due: '마감', mine: '내 일정', other: '기타' }

function categoryOf(event) {
  if (event.source === 'assignment') return 'due'
  if (event.source === 'app') return 'mine'
  return 'other'
}

const eventTime = (event) => event.dueAt ?? event.startAt

function describeEvent(event) {
  const label =
    event.courseName ??
    event.course ??
    (event.source === 'assignment' ? '과제' : '개인 일정')

  if (event.source === 'assignment') return `${label} · 마감`
  if (event.source === 'app' && event.startAt && event.endAt) {
    return `${label} · ${timeInSeoul(event.startAt)} ~ ${timeInSeoul(event.endAt)}`
  }
  return label
}

export default function CalendarView() {
  const [month, setMonth] = useState(() => new Date())
  const [events, setEvents] = useState([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedDay, setSelectedDay] = useState(new Date().getDate())
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const days = new Date(year, monthIndex + 1, 0).getDate()
  const offset = new Date(year, monthIndex, 1).getDay()

  useEffect(() => {
    const controller = new AbortController()
    const from = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01T00:00:00+09:00`
    const toDate = new Date(year, monthIndex + 1, 1)
    const to = `${toDate.getFullYear()}-${String(toDate.getMonth() + 1).padStart(2, '0')}-01T00:00:00+09:00`

    setLoading(true)
    setError('')

    fetch(`/api/calendar/events?${new URLSearchParams({ from, to })}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`일정 조회 실패 (${response.status})`)
        return response.json()
      })
      .then((data) => setEvents(data.events ?? []))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [year, monthIndex, refreshKey])

  const dateKey = (day) =>
    `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  const eventsForDay = (day) =>
    events.filter((event) => {
      const time = event.dueAt ?? event.startAt
      return time && seoulDate(time) === dateKey(day)
    })

  const changeMonth = (delta) => {
    setMonth(new Date(year, monthIndex + delta, 1))
    setSelectedDay(1)
  }

  const goToday = () => {
    const now = new Date()
    setMonth(new Date(now.getFullYear(), now.getMonth(), 1))
    setSelectedDay(now.getDate())
  }

  const selectedEvents = eventsForDay(selectedDay).sort(
    (a, b) => new Date(eventTime(a)) - new Date(eventTime(b))
  )
  const selectedWeekday = WEEKDAYS[new Date(year, monthIndex, selectedDay).getDay()]
  const legend = events.some((event) => categoryOf(event) === 'other')
    ? CATEGORY_ORDER
    : ['due', 'mine']

  return (
    <div className="calendar-view">
      <div className="cal-header">
        <div className="cal-heading">
          <h2 className="cal-title">{monthIndex + 1}월</h2>
          <p className="cal-subtitle">{year}년</p>
        </div>

        <div className="cal-nav">
          <button
            type="button"
            className="cal-nav-arrow"
            onClick={() => changeMonth(-1)}
            aria-label="이전 달"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <button type="button" className="cal-nav-today" onClick={goToday}>
            오늘
          </button>
          <button
            type="button"
            className="cal-nav-arrow"
            onClick={() => changeMonth(1)}
            aria-label="다음 달"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {error && <p className="cal-status" role="alert">{error}</p>}

      <div className="cal-card">
        <div className="cal-grid">
          {WEEKDAYS.map((day, index) => (
            <div
              key={day}
              className={`cal-weekday${index === 0 ? ' is-sun' : ''}${index === 6 ? ' is-sat' : ''}`}
            >
              {day}
            </div>
          ))}

          {Array.from({ length: offset }, (_, index) => (
            <div key={`empty-${index}`} />
          ))}

          {Array.from({ length: days }, (_, index) => {
            const day = index + 1
            const dayEvents = eventsForDay(day)
            const categories = CATEGORY_ORDER.filter((category) =>
              dayEvents.some((event) => categoryOf(event) === category)
            )
            const column = (offset + index) % 7
            const classNames = ['cal-day']
            if (column === 0) classNames.push('is-sun')
            if (column === 6) classNames.push('is-sat')
            if (day === selectedDay) classNames.push('is-selected')

            return (
              <button
                type="button"
                key={day}
                className={classNames.join(' ')}
                onClick={() => setSelectedDay(day)}
                aria-pressed={day === selectedDay}
                aria-label={`${monthIndex + 1}월 ${day}일${dayEvents.length ? `, 일정 ${dayEvents.length}개` : ''}`}
              >
                <span className="cal-day-num">{day}</span>
                <span className="cal-day-dots" aria-hidden="true">
                  {categories.map((category) => (
                    <i key={category} className={`cal-dot is-${category}`} />
                  ))}
                </span>
              </button>
            )
          })}
        </div>

        <div className="cal-legend">
          {legend.map((category) => (
            <span key={category} className="cal-legend-item">
              <i className={`cal-dot is-${category}`} />
              {CATEGORY_LABELS[category]}
            </span>
          ))}
        </div>
      </div>

      <section className="cal-section">
        <div className="cal-section-head">
          <h2 className="cal-section-title">
            {monthIndex + 1}월 {selectedDay}일 {selectedWeekday}요일{' '}
            <span className="cal-section-count">{selectedEvents.length}</span>
          </h2>
        </div>

        <div className="cal-list-card">
          {loading ? (
            <p className="cal-empty">일정을 불러오는 중...</p>
          ) : selectedEvents.length === 0 ? (
            <p className="cal-empty">등록된 일정이 없습니다.</p>
          ) : (
            <ul className="cal-list">
              {selectedEvents.map((event) => (
                <li className="cal-item" key={`${event.source}-${event.id}`}>
                  <span className="cal-item-time">
                    {timeInSeoul(eventTime(event))}
                  </span>
                  <span className="cal-item-body">
                    <strong className="cal-item-title">{event.title}</strong>
                    <span className="cal-item-sub">{describeEvent(event)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <ScheduleManager
        date={dateKey(selectedDay)}
        events={eventsForDay(selectedDay)}
        onChanged={() => setRefreshKey((value) => value + 1)}
      />
    </div>
  )
}
