// 일정 겹침 판단 (ADR 0010, 순수 함수). A.start < B.end && B.start < A.end (맞닿으면 겹침 아님).
// 입력은 시작 → id 순으로 정렬된 구간 일정(하루 종일 · 길이 0 · 취소 · 삭제는 이미 빠짐).
// 쓸어 가기: 앞 일정(a)마다 뒤 일정(b)을 b.start < a.end인 동안만 본다 → 같은 쌍은 한 번, a는 먼저 시작한 쪽(같으면 id 작은 쪽).
// 결과 순서: a.시작 → a.id → b.시작 → b.id (고정). 상한을 넘으면 앞에서부터 max개 + truncated: true
export const MAX_CONFLICTS = 500

const iso = (date) => date.toISOString()
const side = (item) => ({ source: item.source, id: item.id, title: item.title, startAt: iso(item.startAt), endAt: iso(item.endAt) })

function pair(a, b) {
  return {
    kind: 'schedule_overlap',
    a: side(a),
    b: side(b),
    overlapStartAt: iso(b.startAt > a.startAt ? b.startAt : a.startAt),
    overlapEndAt: iso(b.endAt < a.endAt ? b.endAt : a.endAt),
  }
}

// 결과: { conflicts, truncated }
export function findConflicts(items, { max = MAX_CONFLICTS } = {}) {
  const conflicts = []
  for (let i = 0; i < items.length; i += 1) {
    const a = items[i]
    for (let j = i + 1; j < items.length && items[j].startAt < a.endAt; j += 1) {
      if (conflicts.length === max) {
        return { conflicts, truncated: true }
      }
      conflicts.push(pair(a, items[j]))
    }
  }
  return { conflicts, truncated: false }
}
