// Express 4는 async 핸들러의 에러를 잡지 못하므로 next로 넘긴다
export const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next)
