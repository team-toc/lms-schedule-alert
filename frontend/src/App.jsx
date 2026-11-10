import { useState } from 'react'
import Header from './components/Header'
import Navigation from './components/Navigation'
import NotificationList from './features/notifications/NotificationList'
import AssignmentList from './features/assignments/AssignmentList'
import AssignmentDetail from './features/assignments/AssignmentDetail'
import Login from './features/auth/login'
import './App.css'

const assignments = [
  {
    id: 1,
    title: '소수 판별 프로그램 구현',
    course: '프로그래밍 실습',
    deadline: '2026-11-05',
    description: 'Python으로 소수 판별 프로그램을 작성하세요.',
  },
  {
    id: 2,
    title: '프로세스 관리 실습',
    course: '리눅스',
    deadline: '2026-11-08',
    description: '프로세스 관리 명령어를 실습하고 결과를 정리하세요.',
  },
]

function App() {
  const [activeMenu, setActiveMenu] = useState('홈')
  const [selectedId, setSelectedId] = useState(null)
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  const selectedAssignment = assignments.find(
    (assignment) => assignment.id === selectedId
  )

  function handleMenuChange(menu) {
    setActiveMenu(menu)
    setSelectedId(null)
  }

    function handleNotificationSelect(assignmentId) {
    setSelectedId(assignmentId)
    setActiveMenu('과제')
  }

  if (!isLoggedIn) {
    return <Login onLogin={() => setIsLoggedIn(true)} />
  }

  return (
    <div className="app">
      <Header />

      <Navigation
        activeMenu={activeMenu}
        setActiveMenu={handleMenuChange}
      />

      <main className="content">
        {activeMenu === '홈' && (
          <>
            <h2>홈</h2>

            <section className="panel">
              <h3>오늘 일정</h3>
              <p>등록된 일정이 없습니다.</p>
            </section>

            <section className="panel">
              <h3>다가오는 마감</h3>
              <p>예정된 과제가 없습니다.</p>
            </section>

            <NotificationList
              assignments={assignments}
              onSelectAssignment={handleNotificationSelect}
            />
          </>
        )}

        {activeMenu === '알림' && (
          <NotificationList
            assignments={assignments}
            onSelectAssignment={handleNotificationSelect}
          />
        )}

        {activeMenu === '과제' && (
          selectedId === null ? (
            <AssignmentList
              assignments={assignments}
              onSelect={setSelectedId}
            />
          ) : (
            <AssignmentDetail
              assignment={selectedAssignment}
              onBack={() => setSelectedId(null)}
            />
          )
        )}

        {activeMenu === '캘린더' && (
          <section className="panel">
            <h2>캘린더</h2>
            <p>기능을 준비하고 있습니다.</p>
          </section>
        )}

        {activeMenu === '설정' && (
          <section className="panel">
            <h2>설정</h2>
            <p>기능을 준비하고 있습니다.</p>
          </section>
        )}
      </main>
    </div>
  )
}

export default App