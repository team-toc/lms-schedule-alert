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
  const [homeRefreshKey, setHomeRefreshKey] = useState(0)

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
      <Header
        onRefresh={
          activeMenu === '홈'
            ? () => setHomeRefreshKey((key) => key + 1)
            : undefined
        }
      />

      <Navigation
        activeMenu={activeMenu}
        setActiveMenu={handleMenuChange}
      />

      <main className="content">
        {activeMenu === '홈' && (
          <HomeDashboard
            key={homeRefreshKey}
            onOpenCalendar={() => handleMenuChange('캘린더')}
            onOpenNotifications={() => handleMenuChange('알림')}
          />
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
          <div className="settings-view">
            <div className="settings-header">
              <h2 className="settings-title">설정</h2>
              <p className="settings-desc">계정과 Canvas LMS 연동을 관리해요</p>
            </div>

            <section className="settings-section">
              <h3 className="settings-section-title">계정</h3>
              <div className="settings-card settings-account">
                <span className="settings-avatar" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="8.5" r="3.5" />
                    <path d="M5 19.5a7 7 0 0 1 14 0" />
                  </svg>
                </span>
                <span className="settings-account-body">
                  <strong className="settings-account-name">
                    {user?.displayName || '이름 정보 없음'}
                  </strong>
                  <span className="settings-account-status">로그인되어 있어요</span>
                </span>
              </div>
            </section>

            <CanvasSettings />

            <section className="settings-section">
              <h3 className="settings-section-title">계정 관리</h3>
              <div className="settings-card settings-logout">
                {logoutError && (
                  <p role="alert" className="settings-error">{logoutError}</p>
                )}
                <button
                  type="button"
                  className="settings-logout-button"
                  onClick={handleLogout}
                  disabled={isLoggingOut}
                >
                  {isLoggingOut ? '로그아웃 중...' : '로그아웃'}
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}

export default App