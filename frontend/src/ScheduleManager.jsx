import { useState } from 'react'

const dateTime = (date, time) => `${date}T${time}:00+09:00`

const timeInSeoul = (value) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))

export default function ScheduleManager({ date, events, onChanged }) {
  const [title, setTitle] = useState('')
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('10:00')
  const [editingId, setEditingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const schedules = events.filter((event) => event.source === 'app')

  function reset() {
    setTitle('')
    setStart('09:00')
    setEnd('10:00')
    setEditingId(null)
  }

  function edit(schedule) {
    setEditingId(schedule.id)
    setTitle(schedule.title)
    setStart(timeInSeoul(schedule.startAt))
    setEnd(timeInSeoul(schedule.endAt))
    setError('')
  }

  async function request(path, method, body) {
    const response = await fetch(path, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.message || `요청 실패 (${response.status})`)
    }
  }

  async function save(event) {
    event.preventDefault()
    setError('')

    if (!title.trim()) {
      setError('일정 제목을 입력해 주세요.')
      return
    }

    if (start >= end) {
      setError('종료 시간은 시작 시간보다 늦어야 해요.')
      return
    }

    const body = {
      title: title.trim(),
      startAt: dateTime(date, start),
      endAt: dateTime(date, end),
    }

    setBusy(true)
    try {
      if (editingId !== null) {
        await request(`/api/calendar/schedules/${editingId}`, 'PATCH', body)
      } else {
        await request('/api/calendar/schedules', 'POST', body)
      }
      reset()
      onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    if (!window.confirm('이 일정을 삭제할까요?')) return

    setBusy(true)
    setError('')
    try {
      await request(`/api/calendar/schedules/${id}`, 'DELETE')
      reset()
      onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="schedule-manager">
      <h3 className="sm-title">개인 일정 관리</h3>

      <div className="sm-card">
        <form onSubmit={save} className="sm-form">
          <label className="sm-field">
            <span className="sm-label">일정 제목</span>
            <input
              className="sm-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="일정 제목"
              maxLength={255}
              required
            />
          </label>

          <div className="sm-time-row">
            <label className="sm-field">
              <span className="sm-label">시작</span>
              <input
                className="sm-input"
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="sm-field">
              <span className="sm-label">종료</span>
              <input
                className="sm-input"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>

          <div className="sm-actions">
            <button type="submit" className="sm-button is-primary" disabled={busy}>
              {editingId !== null ? '수정 저장' : '일정 추가'}
            </button>
            {editingId !== null && (
              <button type="button" className="sm-button" onClick={reset}>취소</button>
            )}
          </div>
        </form>

        {error && <p role="alert" className="sm-error">{error}</p>}

        {schedules.length > 0 && (
          <ul className="sm-list">
            {schedules.map((schedule) => (
              <li key={schedule.id} className="sm-item">
                <span className="sm-item-body">
                  <strong className="sm-item-title">{schedule.title}</strong>
                  <span className="sm-item-time">
                    {schedule.isAllDay
                      ? '하루 종일'
                      : `${timeInSeoul(schedule.startAt)} ~ ${timeInSeoul(schedule.endAt)}`}
                  </span>
                </span>
                <span className="sm-item-actions">
                  <button
                    type="button"
                    className="sm-button is-small"
                    onClick={() => edit(schedule)}
                    disabled={busy || schedule.isAllDay}
                    title={schedule.isAllDay ? '하루 종일 일정은 이 화면에서 시간을 수정할 수 없어요' : undefined}
                  >
                    수정
                  </button>
                  <button
                    type="button"
                    className="sm-button is-small is-danger"
                    onClick={() => remove(schedule.id)}
                    disabled={busy}
                  >
                    삭제
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
