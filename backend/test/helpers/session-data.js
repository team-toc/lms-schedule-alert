import { sessionIdFrom } from './auth-flow.js'

// 우리 코드가 세션에 넣는 키. 세션 라이브러리가 넣는 cookie 메타데이터는 비교하지 않는다.
const OUR_SESSION_KEYS = ['oauthState', 'googleOAuth', 'userId']

// 쿠키("sid=...")의 세션을 sessions 테이블에서 읽어 우리 키만 돌려준다. 행이 없으면 null.
export async function readOurSessionData(pool, cookie) {
  const [rows] = await pool.query('SELECT data FROM sessions WHERE session_id = ?', [sessionIdFrom(cookie)])
  if (rows.length === 0) {
    return null
  }
  const data = JSON.parse(rows[0].data)
  return Object.fromEntries(OUR_SESSION_KEYS.filter((key) => key in data).map((key) => [key, data[key]]))
}
