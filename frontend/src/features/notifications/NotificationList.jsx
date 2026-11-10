const notifications = [
  {
    id: 1,
    type: '과제',
    assignmentId: 1,
  },
  {
    id: 2,
    type: '공지',
    title: '컴퓨터구조 수업 안내',
    course: '컴퓨터구조',
    date: '11월 2일 등록',
  },
  {
    id: 3,
    type: '과제',
    assignmentId: 2,
  },
]

function formatDeadline(deadline) {
  const [, month, day] = deadline.split('-')
  return `${Number(month)}월 ${Number(day)}일 마감`
}

function NotificationList({ assignments, onSelectAssignment }) {
  return (
    <section className="panel">
      <h2>최근 알림</h2>

      {notifications.map((notification) => {
        const assignment = assignments.find(
          (item) => item.id === notification.assignmentId
        )

        if (notification.assignmentId && !assignment) {
          return null
        }

        return (
          <div className="notification-item" key={notification.id}>
            {assignment ? (
              <button
                type="button"
                className="notification-button"
                onClick={() => onSelectAssignment(assignment.id)}
              >
                <strong>
                  [{notification.type}] {assignment.title}
                </strong>
                <span>
                  {assignment.course} · {formatDeadline(assignment.deadline)}
                </span>
              </button>
            ) : (
              <>
                <strong>
                  [{notification.type}] {notification.title}
                </strong>
                <p>
                  {notification.course} · {notification.date}
                </p>
              </>
            )}
          </div>
        )
      })}
    </section>
  )
}

export default NotificationList