
import clockLogo from '../assets/toc-clock-logo.png'

function Header({ onRefresh }) {
  return (
    <header className="app-header">
      <div className="app-header-brand">
        <img className="app-header-logo" src={clockLogo} alt="" />
        <h1 className="app-header-title">
          일정 <span>알림</span>
        </h1>
      </div>

      <div className="app-header-actions">
        <button
          type="button"
          className="app-header-icon"
          disabled
          aria-label="검색 (준비 중)"
          title="검색 기능은 준비 중입니다"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
        </button>

        <button
          type="button"
          className="app-header-icon"
          onClick={onRefresh}
          disabled={!onRefresh}
          aria-label="새로고침"
          title={onRefresh ? '새로고침' : '홈 화면에서 새로고침할 수 있습니다'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 4v6h-6" />
            <path d="M4 20v-6h6" />
            <path d="M5.5 9a7.5 7.5 0 0 1 12.4-2.8L20 10" />
            <path d="M4 14l2.1 3.8A7.5 7.5 0 0 0 18.5 15" />
          </svg>
        </button>
      </div>
    </header>
  )
}

export default Header
