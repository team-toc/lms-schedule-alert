// 규칙 추출기의 날짜 찾기 (ADR 0011). 한 줄에서 날짜 표현을 찾아 { index, end, date: { year, month, day } }로.
// 상대 날짜 · 연도 없는 날짜의 기준은 게시일의 서울 날짜(base). now는 모른다(같은 입력 → 같은 결과)
const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAYS = '월화수목금토일'

// 연 · 월 · 일 (구분자 . - /), 예: 2026.11.20 · 2026-11-20 · 2026/11/5 · 2026년 11월 20일
const FULL_DATE = /(?<![\dA-Za-z])(20\d{2})(?:\s*[.\-/]\s*|년\s*)(\d{1,2})(?:\s*[.\-/]\s*|월\s*)(\d{1,2})(?:일)?(?!\d|\.\d)/g
// 11월 20일
const KOREAN_DATE = /(?<!\d)(\d{1,2})월\s*(\d{1,2})일/g
// 11/20. 뒤가 점수 · 비율 말이면 날짜가 아니다 (5/10점 · 3/4 이상 · 1/2 감점)
const SLASH_DATE = /(?<![\d/.A-Za-z])(\d{1,2})\/(\d{1,2})(?![\d/]|\s*(?:점|이상|이하|미만|초과|감점|배|%|정도|만큼))/g
// 11.20(금): 점 형식은 요일 괄호가 있을 때만 (소수 · 버전과 가르기)
const DOT_DATE = /(?<![\d.A-Za-z])(\d{1,2})\.(\d{1,2})(?=\s*\([월화수목금토일](?:요일)?\))/g
const RELATIVE_DAY = /(?<![가-힣])(오늘|내일|모레)/g
const RELATIVE_WEEKDAY = /(?<![가-힣])(이번|다음)\s*주\s*([월화수목금토일])요일/g

const utcDay = ({ year, month, day }) => Date.UTC(year, month - 1, day)

function realDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null
}

function addDays(base, days) {
  const d = new Date(utcDay(base) + days * DAY_MS)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

// 연도 없는 날짜: 게시일과 가장 가까운 해(앞뒤 상관없이, 같으면 미래 쪽). 있는 날짜가 없으면 null
function nearestYear(base, month, day) {
  let best = null
  for (const year of [base.year + 1, base.year, base.year - 1]) {
    const candidate = realDate(year, month, day)
    if (candidate && (!best || Math.abs(utcDay(candidate) - utcDay(base)) < Math.abs(utcDay(best) - utcDay(base)))) {
      best = candidate
    }
  }
  return best
}

// 월요일 시작 주
function weekdayDate(base, which, weekday) {
  const baseWeekday = (new Date(utcDay(base)).getUTCDay() + 6) % 7
  return addDays(base, (which === '다음' ? 7 : 0) - baseWeekday + WEEKDAYS.indexOf(weekday))
}

const RULES = [
  [FULL_DATE, (m) => realDate(Number(m[1]), Number(m[2]), Number(m[3]))],
  [KOREAN_DATE, (m, base) => nearestYear(base, Number(m[1]), Number(m[2]))],
  [SLASH_DATE, (m, base) => nearestYear(base, Number(m[1]), Number(m[2]))],
  [DOT_DATE, (m, base) => nearestYear(base, Number(m[1]), Number(m[2]))],
  [RELATIVE_DAY, (m, base) => addDays(base, ['오늘', '내일', '모레'].indexOf(m[1]))],
  [RELATIVE_WEEKDAY, (m, base) => weekdayDate(base, m[1], m[2])],
]

const overlaps = (a, b) => a.index < b.end && b.index < a.end

// 앞 규칙이 먼저 차지한 자리는 뒤 규칙이 다시 쓰지 않는다 (2026-11-20 안의 11-20 등). 없는 날짜도 자리는 차지한다(2026-02-30 안의 02-30)
export function findDates(line, base) {
  const found = []
  for (const [pattern, resolve] of RULES) {
    for (const match of line.matchAll(pattern)) {
      const hit = { index: match.index, end: match.index + match[0].length, date: resolve(match, base) }
      if (!found.some((other) => overlaps(other, hit))) {
        found.push(hit)
      }
    }
  }
  return found.filter((hit) => hit.date).sort((a, b) => a.index - b.index)
}

// 날짜 범위 (ADR 0011): 범위 표시(~ · - · 부터)로 이어진 두 날짜는 하루 종일 일정 하나(끝 날짜 포함).
// 끝이 시작보다 뒤이고 기간(끝 날짜 포함 일수)이 상한 이하일 때만, 아니면 두 날짜를 따로
export const MAX_RANGE_DAYS = 14
const RANGE_LINK = /^\s*(?:\([월화수목금토일](?:요일)?\))?\s*(?:~|〜|-|–|부터)\s*$/

function rangeDays(from, to) {
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS) + 1
}

export function joinRanges(line, hits) {
  const joined = []
  for (let i = 0; i < hits.length; i += 1) {
    const [from, to] = [hits[i], hits[i + 1]]
    const linked = to !== undefined && RANGE_LINK.test(line.slice(from.end, to.index))
    const days = linked ? rangeDays(from.date, to.date) : 0
    if (days > 1 && days <= MAX_RANGE_DAYS) {
      joined.push({ index: from.index, end: to.end, date: from.date, lastDate: to.date })
      i += 1
    } else {
      // 범위로 보지 않은 두 날짜도 종류는 같은 구절에서 (11월 20일 ~ 12월 4일 과제 제출 → 둘 다 마감)
      joined.push(linked ? { ...from, linked: true } : from)
    }
  }
  return joined
}

