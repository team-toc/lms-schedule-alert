// 앱 기준 시간대 Asia/Seoul (ADR 0010 가정). 하루 종일 일정 · 날짜 입력을 이 시간대의 자정으로 해석한다.
// 한국은 1988년 이후 서머타임이 없어 고정 +09:00으로 계산한다. 사용자별 시간대는 후속.
export const APP_TIME_ZONE = 'Asia/Seoul'
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

// 'YYYY-MM-DD'(실제 있는 날짜)만. 아니면 null
export function parseDateOnly(value) {
  const match = typeof value === 'string' ? value.match(DATE_ONLY) : null
  if (!match) {
    return null
  }
  const [year, month, day] = match.slice(1).map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null
  }
  return { year, month, day }
}

// 서울 날짜의 자정 → UTC 시각
export function seoulMidnight({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day) - SEOUL_OFFSET_MS)
}

// UTC 시각 → 그 순간의 서울 날짜 'YYYY-MM-DD'
export function seoulDate(date) {
  return new Date(date.getTime() + SEOUL_OFFSET_MS).toISOString().slice(0, 10)
}
