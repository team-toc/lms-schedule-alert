// 브라우저 푸시 테스트 공용 도구 (ADR 0012): 테스트용 VAPID 키 · 브라우저 구독 키, 가짜 푸시 서비스(실제 네트워크 없음),
// 받은 본문을 브라우저처럼 풀어 보는 RFC 8291 복호화, 앱 조립, DB 읽기. 실제 타이머를 기다리지 않는다
import { createECDH, createHmac, createDecipheriv, generateKeyPairSync, randomBytes } from 'node:crypto'
import { createLmsServices } from '../../src/lms/lms-services.js'
import { createTokenCipher, CIPHER_CONTEXTS } from '../../src/lms/token-cipher.js'
import { createFakeKakaoClient } from './fake-kakao-client.js'
import { createFakeCanvas } from './fake-canvas.js'
import { createLmsClock, TEST_LMS_CONFIG, TEST_TOKEN_KEY } from './lms-context.js'

export const PUBLIC_KEY_PATH = '/api/push/public-key'
export const SUBSCRIPTIONS_PATH = '/api/push/subscriptions'
export const PUSH_TEST_PATH = '/api/push/test'
export const NOTIFICATION_URL = '/?view=notifications'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

// P-256 키 쌍: 공개키 65바이트(0x04 비압축) · 개인키 32바이트, 둘 다 base64url.
// JWK로 꺼낸다: createECDH().getPrivateKey()는 앞자리 0 바이트를 빼 약 1/256 확률로 31바이트가 된다(테스트가 가끔 실패하게 됨)
export function generateVapidKeys() {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
  return { publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])), privateKey: jwk.d }
}

const VAPID = generateVapidKeys()
export const TEST_PUSH_CONFIG = Object.freeze({ vapidPublicKey: VAPID.publicKey, vapidPrivateKey: VAPID.privateKey, vapidSubject: 'mailto:push-test@example.com' })

// 브라우저가 만드는 구독 모양. browser에는 복호화용 비밀(브라우저만 가진 값)
let serial = 0
export function makeSubscription({ host = 'fcm.googleapis.com', path } = {}) {
  serial += 1
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  const endpoint = `https://${host}${path ?? `/fcm/send/SUBSCRIPTIONsecret${String(serial).padStart(4, '0')}${b64url(randomBytes(12))}`}`
  return { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) }, browser: { ecdh, auth } }
}

// 구독 등록 본문(browser는 보내지 않음)
export const subscriptionBody = ({ endpoint, keys }) => ({ endpoint, keys })

const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

// RFC 8291 aes128gcm 복호화(브라우저 쪽). 헤더: salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(응용 서버 공개키) ‖ 암호문
export function decryptPushBody(body, browser) {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const serverPublic = body.subarray(21, 21 + idlen)
  const ciphertext = body.subarray(21 + idlen)
  const secret = browser.ecdh.computeSecret(serverPublic)
  const ikm = hmac(hmac(browser.auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), serverPublic, Buffer.from([1])]))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  return padded.subarray(0, padded.lastIndexOf(2)).toString('utf8')
}

export const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')

// 요청이 n개 도착할 때까지 기다리는 약속(실제 타이머 없음)
function createArrivals(requests) {
  const waiters = []
  const notify = () => {
    for (const w of [...waiters]) {
      if (requests.length >= w.n) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve()
      }
    }
  }
  const reached = (n) =>
    new Promise((resolve) => {
      waiters.push({ n, resolve })
      notify()
    })
  return { notify, reached }
}

// 가짜 푸시 서비스. respond(endpoint, rule) · respondAll(rule): rule = 상태 숫자 | (req) => Response | Promise.reject(..), 기본 201.
// hold(): 요청을 붙잡아 두고 reached(n)으로 n개가 도착할 때까지 기다린 뒤 release()로 풀어 준다(실제 타이머 없음)
export function createFakePushService() {
  const requests = []
  const rules = new Map()
  let fallback = 201
  let gate = null
  const arrivals = createArrivals(requests)
  async function fetch(input, init = {}) {
    const req = { url: String(input), headers: new Headers(init.headers), body: Buffer.from(init.body ?? []), init }
    requests.push(req)
    arrivals.notify()
    if (gate) await gate.promise
    const rule = rules.has(req.url) ? rules.get(req.url) : fallback
    if (typeof rule === 'function') return rule(req)
    return new Response(null, { status: rule })
  }
  return {
    fetch,
    requests,
    respond: (endpoint, rule) => rules.set(endpoint, rule),
    respondAll: (rule) => {
      rules.clear()
      fallback = rule
    },
    hold() {
      let release
      const promise = new Promise((resolve) => {
        release = resolve
      })
      gate = { promise }
      return {
        reached: arrivals.reached,
        release: () => {
          gate = null
          release()
        },
      }
    },
    // 받은 요청을 브라우저 비밀로 풀어 JSON으로
    payloadOf: (req, subscription) => JSON.parse(decryptPushBody(req.body, subscription.browser)),
    to: (endpoint) => requests.filter((r) => r.url === endpoint),
  }
}

// 가짜 Canvas · 가짜 푸시 서비스 · 시계를 끼운 앱. push.fetchFn을 바꿔 끼울 수 있다(모든 요청 실패 등)
export function buildPushApp(ctx, { canvas = createFakeCanvas(), clock = createLmsClock(), logger = ctx.silentLogger, pool = ctx.pool, push = createFakePushService(), pushFetch, maxPending, config } = {}) {
  const lms = createLmsServices({
    pool,
    logger,
    lmsConfig: TEST_LMS_CONFIG,
    fetchFn: canvas.fetch,
    now: clock.now,
    push: { config: TEST_PUSH_CONFIG, fetchFn: pushFetch ?? push.fetch, ...(maxPending ? { maxPending } : {}) },
  })
  const app = ctx.buildApp(createFakeKakaoClient(), { lmsServices: lms, logger, ...(config ? { config } : {}) })
  return { app, lms, clock, canvas, push }
}

export const pushCipher = () => createTokenCipher({ key: TEST_TOKEN_KEY, context: CIPHER_CONTEXTS.pushSubscription })

export async function pushRows(pool, userId) {
  const [rows] = await pool.query(
    `SELECT id, user_id, endpoint_hash, subscription_enc, created_at, last_success_at, consecutive_failures, last_failure_code
     FROM push_subscriptions ${userId === undefined ? '' : 'WHERE user_id = ?'} ORDER BY id`,
    userId === undefined ? [] : [userId],
  )
  return rows.map((r) => ({ ...r }))
}

// 저장된 암호문을 그 행 주인 기준으로 풀어 { endpoint, p256dh, auth }
export function decryptRow(row, userId = row.user_id) {
  return JSON.parse(pushCipher().decrypt(row.subscription_enc, { userId }))
}
