
const notifications = [
  {
    id: 1,
    type: '과제',
    title: '소수 판별 프로그램 구현',
    course: '프로그래밍 실습',
    date: '11월 5일 마감',
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
    title: '프로세스 관리 실습',
    course: '리눅스',
    date: '11월 8일 마감',
    assignmentId: 2,
  },
]

function NotificationList({ onSelectAssignment }) {
  return (
    <section className="panel">
      <h2>최근 알림</h2>

      {notifications.map((notification) => (
        <div className="notification-item" key={notification.id}>
          {notification.assignmentId ? (
            <button
              type="button"
              className="notification-button"
              onClick={() => onSelectAssignment(notification.assignmentId)}
            >
              <strong>
                [{notification.type}] {notification.title}
              </strong>
              <span>
                {notification.course} · {notification.date}
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
      ))}
    </section>
  )
}

export default NotificationList
