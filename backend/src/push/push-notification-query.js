// 푸시 대상 알림 읽기 (ADR 0012). 동기화 반영이 커밋된 뒤 같은 사용자 잠금 안에서 부른다(afterApplied 훅).
// 대상 = 이번 동기화가 만들거나 합친 안 읽은 알림: notification-writer가 둘 다 detected_at = 동기화 시각(at)으로 쓰고,
// 칼럼(DATETIME(3))과 at(JS Date)이 모두 밀리초라 같은 값으로 정확히 비교된다. 공지 본문은 읽지 않는다(제목 · 과목 이름만)
const SELECT_TARGETS = `SELECT n.id, n.kind, n.after_due_at, COALESCE(a.title, an.title) AS title, c.name AS course_name
  FROM notifications n
  LEFT JOIN assignments a ON a.id = n.assignment_id
  LEFT JOIN announcements an ON an.id = n.announcement_id
  JOIN courses c ON c.id = COALESCE(a.course_id, an.course_id)
  WHERE n.user_id = ? AND n.detected_at = ? AND n.read_at IS NULL
  ORDER BY n.id`

export function createPushNotificationQuery(pool) {
  return async function pushTargets(userId, at) {
    const [rows] = await pool.execute(SELECT_TARGETS, [userId, at])
    return rows.map((r) => ({ id: r.id, kind: r.kind, afterDueAt: r.after_due_at, title: r.title, courseName: r.course_name }))
  }
}
