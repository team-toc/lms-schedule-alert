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
    <div style={{ marginTop: 24 }}>
      <h3>개인 일정 관리</h3>

      <form onSubmit={save} style={{ display: 'grid', gap: 10, maxWidth: 450 }}>
        <label>
          일정 제목
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="일정 제목"
            maxLength={255}
            required
            style={{ display: 'block', width: '100%', padding: 8 }}
          />
        </label>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label>
            시작
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            종료
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy}>
            {editingId !== null ? '수정 저장' : '일정 추가'}
          </button>
          {editingId !== null && (
            <button type="button" onClick={reset}>취소</button>
          )}
        </div>
      </form>

      {error && <p role="alert" style={{ color: '#dc2626' }}>{error}</p>}

      {schedules.map((schedule) => (
        <div key={schedule.id} style={{ padding: '12px 0', borderBottom: '1px solid #ddd' }}>
          <strong>{schedule.title}</strong>
          <p>
            {timeInSeoul(schedule.startAt)} ~ {timeInSeoul(schedule.endAt)}
          </p>
          <button type="button" onClick={() => edit(schedule)} disabled={busy}>수정</button>
          {' '}
          <button type="button" onClick={() => remove(schedule.id)} disabled={busy}>삭제</button>
        </div>
      ))}
    </div>
  )
}
