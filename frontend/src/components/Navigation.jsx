
function Navigation({ activeMenu, setActiveMenu }) {
  const menus = ['홈', '캘린더', '알림', '과제', '설정']

  return (
    <nav className="navigation">
      {menus.map((menu) => (
        <button
          key={menu}
          className={activeMenu === menu ? 'active' : ''}
          onClick={() => setActiveMenu(menu)}
        >
          {menu}
        </button>
      ))}
    </nav>
  )
}

export default Navigation
