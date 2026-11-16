// 교시 시간표 설정 (ADR 0011). 코드에 넣지 않고 설정 파일(config/class-periods.json)로, 서버 시작 때 검사한다.
// 모양: { "periods": [{ "period": 1, "start": "09:00", "end": "09:50" }, ...] } — 1교시부터 빠짐없이, 시각 순, 겹침 없음
import { readFile } from 'node:fs/promises'

export class ClassPeriodsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ClassPeriodsError'
  }
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/

function minutesOf(value) {
  const match = typeof value === 'string' ? value.match(HH_MM) : null
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

function checkPeriod(item, index, previousEnd) {
  const label = `periods[${index}]`
  if (item === null || typeof item !== 'object' || item.period !== index + 1) {
    throw new ClassPeriodsError(`${label}: period는 ${index + 1}(정수)이어야 합니다`)
  }
  const start = minutesOf(item.start)
  const end = minutesOf(item.end)
  if (start === null || end === null) {
    throw new ClassPeriodsError(`${item.period}교시: start · end는 HH:mm 형식이어야 합니다`)
  }
  if (start >= end) {
    throw new ClassPeriodsError(`${item.period}교시: start가 end보다 앞서야 합니다`)
  }
  if (previousEnd !== null && start < previousEnd) {
    throw new ClassPeriodsError(`${item.period}교시: 앞 교시와 겹칩니다`)
  }
  return end
}

// → Map<교시 번호, { start: 'HH:mm', end: 'HH:mm' }>
export function parseClassPeriods(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.periods)) {
    throw new ClassPeriodsError('교시 시간표는 { "periods": [...] } 모양이어야 합니다')
  }
  const periods = new Map()
  let previousEnd = null
  raw.periods.forEach((item, index) => {
    previousEnd = checkPeriod(item, index, previousEnd)
    periods.set(item.period, { start: item.start, end: item.end })
  })
  return periods
}

export async function loadClassPeriods(path) {
  let raw
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    throw new ClassPeriodsError(`교시 시간표 파일을 읽을 수 없습니다 (${err.code ?? err.name})`)
  }
  return parseClassPeriods(raw)
}

// 서버 시작용: 틀리면 이유만 출력하고 종료 (설정 오류와 같은 방식)
export async function loadClassPeriodsOrExit(path) {
  try {
    return await loadClassPeriods(path)
  } catch (err) {
    if (!(err instanceof ClassPeriodsError)) {
      throw err
    }
    console.error(`교시 시간표 설정 오류: ${err.message}`)
    process.exit(1)
  }
}
