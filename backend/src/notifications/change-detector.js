// 변경 감지 규칙 (ADR 0009). DB · 시계를 모르는 순수 함수: 사용자가 마지막으로 본 값과 이번 Canvas 값을 비교해 변경 목록을 돌려준다.
// 의미 없는 알림 줄이기: 이미 지난 과제(마감이 지금 이전)의 변경 · 사라짐 · 늦게 보인 지난 과제는 알리지 않는다.
// 기준 동기화(첫 동기화 · 다른 계정 · 새 과목)는 이 함수를 부르지 않는다(호출하는 쪽에서 결정).

const time = (date) => (date ? date.getTime() : null)
// 마감이 없거나 지금 이후면 "아직 의미 있는" 과제
const isOpen = (dueAt, now) => dueAt === null || dueAt > now

function assignmentChange(kind, assignmentId, values) {
  return { kind, assignmentId, announcementId: null, beforeDueAt: null, afterDueAt: null, beforeTitle: null, afterTitle: null, ...values }
}

function changesOfLinked(seen, item, now) {
  const found = []
  const dueChanged = time(seen.dueAt) !== time(item.dueAt)
  // 마감 변경: 전 · 후 중 하나라도 지금 이후일 때만 (지난 값 → 없음 · 지난 값끼리는 알리지 않음)
  if (dueChanged && ((seen.dueAt && seen.dueAt > now) || (item.dueAt && item.dueAt > now))) {
    found.push(assignmentChange('assignment_due_changed', item.id, { beforeDueAt: seen.dueAt, afterDueAt: item.dueAt }))
  }
  // 제목: 본 제목이 NULL이면 "모름" → 알림 없이 채운다
  if (seen.title !== null && seen.title !== item.title && isOpen(item.dueAt, now)) {
    found.push(assignmentChange('assignment_title_changed', item.id, { beforeTitle: seen.title, afterTitle: item.title }))
  }
  return found
}

// seen: Map(assignmentId → { dueAt, title }) 이번 동기화 전 이 과목의 연결
// current: [{ id, title, dueAt }] 이번에 보이는 과제, removedIds: 이 과목 안에서 이번에 연결이 끊긴 과제
export function detectAssignmentChanges({ seen, current, removedIds, now }) {
  const found = []
  for (const item of current) {
    const before = seen.get(item.id)
    if (!before) {
      if (isOpen(item.dueAt, now)) {
        found.push(assignmentChange('assignment_created', item.id, { afterDueAt: item.dueAt }))
      }
      continue
    }
    found.push(...changesOfLinked(before, item, now))
  }
  for (const id of removedIds) {
    const before = seen.get(id)
    if (before && isOpen(before.dueAt, now)) {
      found.push(assignmentChange('assignment_removed', id, { beforeDueAt: before.dueAt }))
    }
  }
  return found
}

// seen: Map(announcementId → { title, contentHash }), current: [{ id, title, contentHash }]
// 처음 보이는 공지는 "새 공지"만, 본 해시가 NULL이면 알림 없이 채운다. 공지 사라짐은 알리지 않는다.
export function detectAnnouncementChanges({ seen, current }) {
  const found = []
  for (const item of current) {
    const before = seen.get(item.id)
    const base = { assignmentId: null, announcementId: item.id, beforeDueAt: null, afterDueAt: null }
    if (!before) {
      found.push({ ...base, kind: 'announcement_created', beforeTitle: null, afterTitle: null })
    } else if (before.contentHash !== null && before.contentHash !== item.contentHash) {
      found.push({ ...base, kind: 'announcement_updated', beforeTitle: before.title ?? item.title, afterTitle: item.title })
    }
  }
  return found
}
