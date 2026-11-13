// 캘린더 조회 경계 레이어 (ADR 0008). 과제 마감은 schedules로 복사하지 않고 assignments를 읽어 합친다.
// 항상 사용자 연결(user_assignments)을 거치고, 지금 연동 중(lms_tokens)이며 수강 중(enrollments)인 과목의 과제만 본다.
// 마감 없는 과제(due_at NULL) · deleted_at이 있는 과제는 나오지 않는다. 마감 → id 순서로 항상 같은 결과.
const SELECT_ASSIGNMENT_EVENTS = `SELECT a.id, c.name AS course_name, a.title, ua.due_at, a.html_url
  FROM user_assignments ua
  JOIN lms_tokens t ON t.user_id = ua.user_id
  JOIN assignments a ON a.id = ua.assignment_id
  JOIN enrollments e ON e.user_id = ua.user_id AND e.course_id = a.course_id
  JOIN courses c ON c.id = a.course_id
  WHERE ua.user_id = ? AND ua.due_at >= ? AND ua.due_at < ? AND a.deleted_at IS NULL
  ORDER BY ua.due_at, a.id`

function toEvent(row) {
  return {
    source: 'assignment',
    id: row.id,
    courseName: row.course_name,
    title: row.title,
    dueAt: row.due_at.toISOString(),
    url: row.html_url,
  }
}

export function createCalendarRepository(pool) {
  async function listAssignmentEvents(userId, { from, to }) {
    const [rows] = await pool.execute(SELECT_ASSIGNMENT_EVENTS, [userId, from, to])
    return rows.map(toEvent)
  }

  return { listAssignmentEvents }
}
