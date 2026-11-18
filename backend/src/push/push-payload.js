// 푸시 내용 만들기 (ADR 0012). 잠금 화면에 보이므로 짧게: 종류별 고정 제목 + "과목 · 제목"(+ 마감이면 서울 시각).
// 공지 본문 · 제안 맥락은 넣지 않는다. 한 동기화에 4개 이상이면 요약 하나. JSON 전체 1024바이트 이하
export const PUSH_NOTIFICATION_URL = '/?view=notifications'
export const SUMMARY_THRESHOLD = 4
export const MAX_PAYLOAD_BYTES = 1024
const COURSE_MAX = 40
const TITLE_MAX = 80
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000

const KIND_TITLES = {
  assignment_created: '새 과제',
  assignment_due_changed: '마감 변경',
  assignment_title_changed: '과제 이름 변경',
  assignment_removed: '과제 삭제',
  announcement_created: '새 공지',
  announcement_updated: '공지 수정',
}
const WITH_DUE = new Set(['assignment_created', 'assignment_due_changed'])

// 코드포인트 기준으로 자른다(이모지 · 한글을 반으로 깨지 않음)
const clip = (text, max) => {
  const chars = Array.from(String(text ?? ''))
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

// 서울 시각 'M/D HH:mm'
function seoulShort(date) {
  const d = new Date(date.getTime() + SEOUL_OFFSET_MS)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}:${mm}`
}

function bodyOf(n) {
  const parts = [clip(n.courseName, COURSE_MAX), clip(n.title, TITLE_MAX)]
  if (WITH_DUE.has(n.kind) && n.afterDueAt) {
    parts.push(seoulShort(n.afterDueAt))
  }
  return parts.join(' · ')
}

const message = (payload, topic) => {
  const text = JSON.stringify(payload)
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new RangeError('push payload too large')
  }
  return { payload: text, topic }
}

// 대상 알림 → 보낼 메시지 [{ payload(JSON 문자열), topic }]. Topic은 RFC 8030 5.4(아직 안 간 같은 주제 메시지를 바꿔치기)
export function buildPushMessages(notifications) {
  if (notifications.length >= SUMMARY_THRESHOLD) {
    const count = notifications.length
    return [message({ v: 1, notificationId: null, kind: 'summary', count, title: `새 알림 ${count}개`, body: '앱에서 바뀐 내용을 확인하세요', url: PUSH_NOTIFICATION_URL }, 'summary')]
  }
  return notifications.map((n) => message({ v: 1, notificationId: n.id, kind: n.kind, title: KIND_TITLES[n.kind], body: bodyOf(n), url: PUSH_NOTIFICATION_URL }, `n${n.id}`))
}

export const testPushMessage = () => message({ v: 1, notificationId: null, kind: 'test', title: '테스트 알림', body: '이 브라우저로 푸시 알림이 옵니다', url: PUSH_NOTIFICATION_URL }, 'test')
