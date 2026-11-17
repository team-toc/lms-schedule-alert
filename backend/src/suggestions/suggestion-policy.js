// 제안 단계의 정책 (ADR 0011): 추출 결과 → 저장할 후보. now를 아는 쪽은 여기(추출기는 모름)
// 지난 날짜 제외(시각 일정은 시작 <= now, 하루 종일은 끝 <= now — 목록 만료 규칙과 같음) → 같은 시각(후보 키)은 하나 → 공지당 상한(본문 앞쪽부터)
import { createHash } from 'node:crypto'

export const MAX_SUGGESTIONS_PER_ANNOUNCEMENT = 5

// 종류는 키에 넣지 않는다: 같은 시각이 다른 종류로 분류돼도 같은 제안 (리뷰 결정 5b)
export function candidateKey({ startAt, endAt, isAllDay }) {
  return createHash('sha256').update(`${startAt.toISOString()}|${endAt.toISOString()}|${isAllDay ? 1 : 0}`).digest('hex')
}

export function isPast({ startAt, endAt, isAllDay }, now) {
  return (isAllDay ? endAt : startAt).getTime() <= now.getTime()
}

// → [{ key, kind, startAt, endAt, isAllDay, context }] (본문 순서)
export function selectCandidates(candidates, now) {
  const selected = new Map()
  for (const candidate of candidates) {
    if (selected.size >= MAX_SUGGESTIONS_PER_ANNOUNCEMENT) {
      break
    }
    const key = candidateKey(candidate)
    if (!isPast(candidate, now) && !selected.has(key)) {
      selected.set(key, { key, ...candidate })
    }
  }
  return [...selected.values()]
}
