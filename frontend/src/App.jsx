import { useEffect, useState } from 'react'
import Header from './components/Header'
import Navigation from './components/Navigation'
import NotificationList from './features/notifications/NotificationList'
import AssignmentList from './features/assignments/AssignmentList'
import AssignmentDetail from './features/assignments/AssignmentDetail'
import Login from './features/auth/login'
import { fetchCurrentUser, logout } from './features/auth/authApi'
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
  const [authStatus, setAuthStatus] = useState('checking')
  const [user, setUser] = useState(null)
  const [authError, setAuthError] = useState('')
  const [sessionCheckCount, setSessionCheckCount] = useState(0)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')

  useEffect(() => {
    let ignore = false

    fetchCurrentUser().then((result) => {
      if (ignore) {
        return
      }
      if (result.status === 'authenticated') {
        setUser(result.user)
        setAuthStatus('authenticated')
      } else if (result.status === 'unauthenticated') {
        setAuthStatus('unauthenticated')
      } else {
        setAuthError(result.message)
        setAuthStatus('error')
      }
    })

    return () => {
      ignore = true
    }
  }, [sessionCheckCount])

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

  function handleRetrySessionCheck() {
    setAuthStatus('checking')
    setSessionCheckCount((count) => count + 1)
  }

  function handleLogin(loggedInUser) {
    setUser(loggedInUser)
    setActiveMenu('홈')
    setSelectedId(null)
    setAuthStatus('authenticated')
  }

  async function handleLogout() {
    setLogoutError('')
    setIsLoggingOut(true)

    const result = await logout()

    setIsLoggingOut(false)

    if (!result.ok) {
      setLogoutError(result.message)
      return
    }

    setUser(null)
    setAuthStatus('unauthenticated')
  }

  if (authStatus === 'checking') {
    return (
      <div className="app">
        <main className="content">
          <section className="panel">
            <p>로그인 상태를 확인하고 있습니다...</p>
          </section>
        </main>
      </div>
    )
  }

  if (authStatus === 'error') {
    return (
      <div className="app">
        <main className="content">
          <section className="panel">
            <p>{authError}</p>
            <button
              type="button"
              className="login-button"
              onClick={handleRetrySessionCheck}
            >
              다시 시도
            </button>
          </section>
        </main>
      </div>
    )
  }

  if (authStatus === 'unauthenticated') {
    return <Login onLogin={handleLogin} />
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

            <h3>계정</h3>
            <p>{user?.displayName}님으로 로그인되어 있습니다.</p>
            {logoutError && <p>{logoutError}</p>}
            <button
              type="button"
              className="login-button"
              onClick={handleLogout}
              disabled={isLoggingOut}
            >
              {isLoggingOut ? '로그아웃 중...' : '로그아웃'}
            </button>
          </section>
        )}
      </main>
    </div>
  )
}

export default App