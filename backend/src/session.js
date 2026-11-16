import session from 'express-session'
import createMySQLStore from 'express-mysql-session'

export const SESSION_COOKIE_NAME = 'sid'
const MySQLStore = createMySQLStore(session)

// 세션을 MariaDB sessions 테이블에 저장한다. 테이블은 마이그레이션이 만들므로 자동 생성은 끈다.
export function createSessionStore(pool, { ttlMs, clearExpired = true }) {
  return new MySQLStore(
    {
      createDatabaseTable: false,
      // 풀은 앱이 관리한다. 저장소를 닫아도 풀은 닫지 않는다.
      endConnectionOnClose: false,
      clearExpired,
      expiration: ttlMs,
    },
    pool,
  )
}

export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
  }
}

export function createSessionMiddleware({ config, store }) {
  return session({
    name: SESSION_COOKIE_NAME,
    secret: config.session.secret,
    store,
    resave: false,
    // 로그인 시작(state 저장) 전에는 세션 · 쿠키를 만들지 않는다
    saveUninitialized: false,
    // 요청이 있을 때마다 만료를 연장한다
    rolling: true,
    cookie: { ...sessionCookieOptions(config), maxAge: config.session.ttlMs },
  })
}
