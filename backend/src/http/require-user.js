// 로그인한 사용자만 통과시키는 미들웨어. 세션의 사용자가 DB에 실제로 있을 때 req.user에 넣는다.
// (인증 라우트의 세션 정리는 /api/auth/me · /logout이 맡는다. 여기서는 401만 돌려준다.)
import { asyncRoute } from '../auth/async-route.js'

const HTTP_UNAUTHORIZED = 401
const NOT_AUTHENTICATED = { error: 'not_authenticated', message: '로그인이 필요합니다.' }

export function createRequireUser({ accountService }) {
  return asyncRoute(async (req, res, next) => {
    const userId = req.session?.userId
    const user = userId ? await accountService.findUserById(userId) : null
    if (!user) {
      return res.status(HTTP_UNAUTHORIZED).json(NOT_AUTHENTICATED)
    }
    req.user = user
    next()
  })
}
