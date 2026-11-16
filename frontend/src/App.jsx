import { useEffect, useState } from 'react'
import Header from './components/Header'
import Navigation from './components/Navigation'
import NotificationList from './components/NotificationList'
import AssignmentList from './components/AssignmentList'
import AssignmentDetail from './components/AssignmentDetail'
import Login from './features/auth/login'
import { fetchCurrentUser, logout } from './features/auth/authApi'
import CalendarView from './CalendarView'
import CanvasSettings from './CanvasSettings'
import AssignmentPage from './AssignmentPage'
import HomeDashboard from './HomeDashboard'
import './App.css'

const assignments = []

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

            <HomeDashboard />

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

        {activeMenu === '과제' && <AssignmentPage />}

        {activeMenu === '캘린더' && <CalendarView />}

        {activeMenu === '설정' && (
          <section className="panel">
            <h2>설정</h2>
            <CanvasSettings />

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