// 규칙 기반 일정 추출기 (ADR 0011). AI 없이 정규식 · 낱말만. 바꿔 끼울 수 있는 경계: { extract({ title, text, postedAt }) → 후보[] }
// 결정적 순수 함수: now · 서버 시간대를 모르고, 시각은 서울로 해석해 UTC Date로 돌려준다.
// 지난 날짜 · 중복 · 상한은 추출기 밖(제안 단계)에서 거른다.
import { createHash } from 'node:crypto'
import { parseDateOnly, seoulDate, seoulMidnight } from '../calendar/seoul-time.js'
import { findDates, joinRanges } from './date-patterns.js'
import { findTime, startsWithTime } from './time-patterns.js'

// 규칙 버전. **추출 규칙(정규식 · 낱말 · 묶기 · 시각 계산)을 바꾸면 반드시 1 올린다** — 버전이 바뀌면 이미 훑은 공지도
// 다음 동기화에서 한 번 다시 분석된다(ADR 0011, 2026-11-19). 교시 시간표 내용은 따로 버전에 들어가므로 시간표만 바꿀 때는 올리지 않아도 된다.
// 1: 첫 규칙, 2: 쉼표 뒤 시각 묶기 · 명시 시각 + 교시 끝 · 시험 평가 낱말(2026-11-19)
export const EXTRACTOR_RULES_VERSION = 2

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
export const CONTEXT_MAX = 60
const CONTEXT_BEFORE = 20
const URL = /\b(?:https?:\/\/|www\.)\S+/gi
const SEPARATOR = /[,;!?。]|\.(?=\s|$)/g
const KINDS = [
  // "평가" 한 낱말 · 강의평가는 시험이 아니다(2026-11-19): 시험 종류를 밝힌 평가만
  ['exam', /중간고사|기말고사|쪽지\s*시험|시험|퀴즈|중간평가|기말평가|수시평가|실기평가|quiz|exam/gi],
  ['cancellation', /휴강|결강/g],
  ['makeup', /보강/g],
  ['deadline', /마감|제출|기한|\bdue\b/gi],
]

// 날짜 자리 안의 점(2026. 11. 20)은 구절 구분이 아니다
function separatorsOf(line, dates) {
  return [...line.matchAll(SEPARATOR)].map((m) => m.index).filter((i) => !dates.some((d) => i >= d.index && i < d.end))
}

// 날짜를 둘러싼 구절 [start, end): 앞뒤 구분자 사이
function clauseOf(separators, hit, length) {
  const before = separators.filter((i) => i < hit.index)
  const after = separators.find((i) => i >= hit.end)
  return { start: before.length ? before[before.length - 1] + 1 : 0, end: after ?? length }
}

// 날짜 구절이 쉼표로 끝나고 다음 구절이 시각으로 시작하면("일시: 11월 20일, 오후 3시") 그 구절까지 같은 일정으로 묶는다.
// 한 번만 건너고, 그 사이에 다른 날짜가 있으면 묶지 않는다(시각은 뒤따르는 날짜 것). 묶지 않는 쉼표는 그대로 구절 경계 (ADR 0011, 2026-11-19)
function extendOverComma(line, separators, clause, nextDate) {
  if (line[clause.end] !== ',') {
    return clause
  }
  const following = separators.find((i) => i > clause.end) ?? line.length
  const end = Math.min(following, nextDate?.index ?? line.length)
  return startsWithTime(line.slice(clause.end + 1, end)) ? { start: clause.start, end } : clause
}

// 날짜에 가장 가까운 종류 낱말
function closestKind(region, from, to) {
  let best = null
  for (const [kind, pattern] of KINDS) {
    for (const m of region.matchAll(pattern)) {
      const distance = m.index >= to ? m.index - to : Math.max(0, from - (m.index + m[0].length))
      if (!best || distance < best.distance) {
        best = { kind, distance }
      }
    }
  }
  return best?.kind ?? null
}

function contextOf(line, clause, hit) {
  let start = clause.start
  if (clause.end - clause.start > CONTEXT_MAX) {
    start = Math.max(clause.start, Math.min(hit.index - CONTEXT_BEFORE, clause.end - CONTEXT_MAX))
  }
  const text = line.slice(start, Math.min(clause.end, start + CONTEXT_MAX)).toWellFormed().replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, CONTEXT_MAX).join('')
}

// 범위(lastDate)는 끝 날짜 다음 날 0시까지 하루 종일
function timesOf(hit, time) {
  const midnight = seoulMidnight(hit.date).getTime()
  if (hit.lastDate) {
    return { startAt: new Date(midnight), endAt: new Date(seoulMidnight(hit.lastDate).getTime() + DAY_MS), isAllDay: true }
  }
  if (!time) {
    return { startAt: new Date(midnight), endAt: new Date(midnight + DAY_MS), isAllDay: true }
  }
  return { startAt: new Date(midnight + time.startMinutes * MINUTE_MS), endAt: new Date(midnight + time.endMinutes * MINUTE_MS), isAllDay: false }
}

// near: 앞뒤 날짜 사이(시각은 여기서), kindArea: 종류 낱말을 찾는 곳(범위로 이은 두 날짜는 구절 전체)
function areasOf(dates, i, clause) {
  const [previous, hit, next] = [dates[i - 1], dates[i], dates[i + 1]]
  const near = { start: Math.max(clause.start, previous?.end ?? 0), end: Math.min(clause.end, next?.index ?? clause.end) }
  const kindArea = { start: previous?.linked ? clause.start : near.start, end: hit.linked ? clause.end : near.end }
  return { near, kindArea }
}

function lineCandidates(rawLine, { base, title, classPeriods }) {
  const line = rawLine.replace(URL, ' ')
  const dates = joinRanges(line, findDates(line, base))
  const separators = separatorsOf(line, dates)
  return dates.map((hit, i) => {
    const clause = extendOverComma(line, separators, clauseOf(separators, hit, line.length), dates[i + 1])
    const { near, kindArea } = areasOf(dates, i, clause)
    const time = hit.lastDate ? null : findTime(line.slice(hit.end, near.end), classPeriods)
    const kind = closestKind(line.slice(kindArea.start, kindArea.end), hit.index - kindArea.start, hit.end - kindArea.start) ?? closestKind(title, 0, 0) ?? 'other'
    return { kind, ...timesOf(hit, time), context: contextOf(line, clause, hit) }
  })
}

// 교시 시간표 내용의 짧은 해시(교시 순서대로, 같은 내용이면 같은 값)
function periodsDigest(classPeriods) {
  const entries = [...classPeriods.entries()].sort(([x], [y]) => x - y)
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16)
}

export function createRuleExtractor({ classPeriods }) {
  return {
    // 추출기 버전: 규칙 버전 상수 + 교시 시간표 내용. 제안 단계가 훑은 기록 판단에 쓴다
    version: `rules:${EXTRACTOR_RULES_VERSION}|periods:${periodsDigest(classPeriods)}`,
    extract({ title, text, postedAt }) {
      const base = parseDateOnly(seoulDate(postedAt))
      const options = { base, title: title ?? '', classPeriods }
      return String(text ?? '')
        .split('\n')
        .flatMap((line) => lineCandidates(line, options))
    },
  }
}
