
const ICONS = {
  홈: (
    <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />
  ),
  캘린더: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
      <path d="M8.5 13.5h.01M12 13.5h.01M15.5 13.5h.01M8.5 16.5h.01M12 16.5h.01" />
    </>
  ),
  알림: (
    <>
      <path d="M18 9.5a6 6 0 0 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 15.5 18 9.5" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
    </>
  ),
  과제: (
    <>
      <rect x="5" y="4.5" width="14" height="16" rx="2.5" />
      <path d="M9.5 3h5v3h-5z" />
      <path d="m9 13 2.2 2.2L15.5 11" />
    </>
  ),
  설정: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
}

function Navigation({ activeMenu, setActiveMenu }) {
  const menus = ['홈', '캘린더', '알림', '과제', '설정']

  return (
    <nav className="app-nav" aria-label="주요 메뉴">
      {menus.map((menu) => (
        <button
          key={menu}
          type="button"
          className={`app-nav-item${activeMenu === menu ? ' active' : ''}`}
          aria-current={activeMenu === menu ? 'page' : undefined}
          onClick={() => setActiveMenu(menu)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {ICONS[menu]}
          </svg>
          <span>{menu}</span>
        </button>
      ))}
    </nav>
  )
}

export default Navigation
