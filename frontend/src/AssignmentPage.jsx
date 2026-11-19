import { useEffect, useState } from 'react'

const fmt = (value) =>
  new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

function monthRange(year, month) {
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 1)

  const iso = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01T00:00:00+09:00`

  return { from: iso(start), to: iso(end) }
}

export default function AssignmentPage() {
  const [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    const controller = new AbortController()

    async function load() {
      setLoading(true)
      setError('')

      try {
        const now = new Date()
        const requests = []

        // 최근 6개월부터 앞으로 2개월까지 조회
        for (let i = -6; i <= 2; i++) {
          const range = monthRange(
            now.getFullYear(),
            now.getMonth() + i
          )

          const params = new URLSearchParams(range)

          requests.push(
            fetch(`/api/calendar/events?${params}`, {
              credentials: 'include',
              signal: controller.signal,
            }).then(async (response) => {
              if (!response.ok) {
                throw new Error(`과제 조회 실패 (${response.status})`)
              }
              return response.json()
            })
          )
        }

        const results = await Promise.all(requests)

        const unique = new Map()

        results.forEach((result) => {
          (result.events ?? [])
            .filter((item) => item.source === 'assignment')
            .forEach((item) => unique.set(item.id, item))
        })

        const items = [...unique.values()].sort(
          (a, b) => new Date(a.dueAt) - new Date(b.dueAt)
        )

        if (!controller.signal.aborted) {
          setAssignments(items)
        }
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    load()
    return () => controller.abort()
  }, [])

  if (selected) {
    return (
      <section className="panel">
        <button type="button" className="back-button" onClick={() => setSelected(null)}>
          ← 목록으로
        </button>

        <h2>{selected.title}</h2>
        <p>과목: {selected.courseName ?? '과목 정보 없음'}</p>
        <p>마감일: {fmt(selected.dueAt)}</p>

        {selected.url && (
          <a href={selected.url} target="_blank" rel="noopener noreferrer">
            LMS에서 과제 보기
          </a>
        )}
      </section>
    )
  }

  return (
    <section className="panel">
      <h2>과제 목록</h2>

      {loading && <p>과제를 불러오는 중...</p>}
      {error && <p role="alert">{error}</p>}

      {!loading && !error && assignments.length === 0 && (
        <p>조회 기간에 마감일이 있는 과제가 없습니다.</p>
      )}

      {!loading && !error && (
        <>
          <p>조회된 과제: {assignments.length}개</p>

          {assignments.map((item) => (
            <button
              type="button"
              className="assignment-item"
              key={item.id}
              onClick={() => setSelected(item)}
            >
              <strong>{item.title}</strong>
              <span>
                {item.courseName ?? '과목 정보 없음'} · {fmt(item.dueAt)} 마감
              </span>
            </button>
          ))}
        </>
      )}
    </section>
  )
}
