import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { openTestContext } from './helpers/test-context.js'
import { createFakeKakaoClient } from './helpers/fake-kakao-client.js'

const API_DOC_PATH = fileURLToPath(new URL('../docs/api.md', import.meta.url))
// api.md에서 엔드포인트는 "### GET /api/..." 형식의 제목으로 쓴다
const DOC_ENDPOINT_HEADING = /^### (GET|POST|PUT|PATCH|DELETE) (\/\S+)\s*$/

// Express 4: 마운트 경로 정규식("^\/api\/auth\/?(?=\/|$)")을 "/api/auth"로 되돌린다
function mountPathOf(layer) {
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/')
}

// 앱에 등록된 라우트를 "METHOD /path" 목록으로 뽑는다 (에러 처리 미들웨어 등 라우트가 아닌 것은 뺀다)
function listRoutes(stack, prefix = '') {
  const routes = []
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        routes.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`)
      }
    } else if (layer.name === 'router' && layer.handle.stack) {
      routes.push(...listRoutes(layer.handle.stack, prefix + mountPathOf(layer)))
    }
  }
  return routes
}

function documentedEndpoints(markdown) {
  return markdown
    .split('\n')
    .map((line) => line.match(DOC_ENDPOINT_HEADING))
    .filter(Boolean)
    .map(([, method, path]) => `${method} ${path}`)
}

describe('docs/api.md가 실제 라우트와 맞는다', () => {
  let ctx
  let routes
  let documented

  before(async () => {
    ctx = await openTestContext()
    const app = ctx.buildApp(createFakeKakaoClient())
    routes = listRoutes(app._router.stack)
    documented = documentedEndpoints(await readFile(API_DOC_PATH, 'utf8'))
  })
  after(async () => {
    await ctx.close()
  })

  it('라우트 목록을 실제로 뽑았다 (검사 자체가 비어 있지 않음)', () => {
    assert.ok(routes.includes('GET /api/health'))
    assert.ok(routes.includes('POST /api/auth/email/login'))
    assert.ok(routes.length >= 9, `라우트 ${routes.length}개`)
  })

  it('앱에 등록된 모든 라우트가 api.md에 "### METHOD 경로" 제목으로 있다', () => {
    const missing = routes.filter((route) => !documented.includes(route))
    assert.deepEqual(missing, [], `api.md에 없는 라우트: ${missing.join(', ')}`)
  })

  it('api.md의 엔드포인트 제목은 모두 실제 라우트다 (지워진 라우트가 문서에 남지 않음)', () => {
    const stale = documented.filter((endpoint) => !routes.includes(endpoint))
    assert.deepEqual(stale, [], `코드에 없는 문서 항목: ${stale.join(', ')}`)
  })

  it('같은 엔드포인트를 두 번 쓰지 않는다', () => {
    assert.equal(new Set(documented).size, documented.length)
  })
})
