import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePushSubscription, parsePushEndpoint, isAllowedPushEndpoint, MAX_ENDPOINT_LENGTH } from '../src/push/push-subscription-input.js'
import { makeSubscription } from './helpers/push-context.js'

const KEYS = makeSubscription().keys
const body = (endpoint, keys = KEYS) => ({ endpoint, keys })
const errorOf = (input) => parsePushSubscription(input).error

// 구독 입력 검사 (ADR 0012): endpoint는 https · 알려진 브라우저 푸시 서비스 호스트만(정확히 같거나 점 경계 접미사),
// 계정 정보 · 443 밖 포트 · IP 거부, 길이 상한. 키는 base64url · 길이(p256dh 65바이트 0x04, auth 16바이트)
describe('푸시 구독 입력 검사', () => {
  it('Chrome(FCM) · Firefox · Safari · Edge(WNS) 구독은 받는다 (호스트 대소문자 무시, endpoint 문자열은 그대로)', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:APA91bExample',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample',
      'https://web.push.apple.com/QOk1Example',
      'https://wns2-sg2p.notify.windows.com/w/?token=BQYAAABexample',
      'https://FCM.GoogleAPIs.com/fcm/send/upper',
      'https://fcm.googleapis.com:443/fcm/send/explicit-port',
    ]) {
      const { value, error } = parsePushSubscription(body(endpoint))
      assert.equal(error, undefined, endpoint)
      assert.deepEqual(value, { endpoint, p256dh: KEYS.p256dh, auth: KEYS.auth })
    }
  })

  it('endpoint가 없거나 문자열이 아니거나 너무 길면 400 코드', () => {
    assert.deepEqual(errorOf({ keys: KEYS }), { code: 'missing_endpoint', field: 'endpoint' })
    assert.deepEqual(errorOf(body('')), { code: 'missing_endpoint', field: 'endpoint' })
    assert.deepEqual(errorOf(body(42)), { code: 'invalid_endpoint', field: 'endpoint' })
    const long = `https://fcm.googleapis.com/fcm/send/${'x'.repeat(MAX_ENDPOINT_LENGTH)}`
    assert.deepEqual(errorOf(body(long)), { code: 'endpoint_too_long', field: 'endpoint' })
    assert.equal(MAX_ENDPOINT_LENGTH, 2048)
    assert.deepEqual(errorOf(null), { code: 'missing_endpoint', field: 'endpoint' })
  })

  it('https가 아니면 insecure_endpoint, URL이 아니거나 계정 정보 · 443 밖 포트면 invalid_endpoint', () => {
    for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'wss://updates.push.services.mozilla.com/x', 'ftp://web.push.apple.com/x']) {
      assert.deepEqual(errorOf(body(endpoint)), { code: 'insecure_endpoint', field: 'endpoint' }, endpoint)
    }
    for (const endpoint of [
      'not a url',
      'https://user@fcm.googleapis.com/fcm/send/x',
      'https://user:pw@web.push.apple.com/x',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://web.push.apple.com:80/x',
    ]) {
      assert.deepEqual(errorOf(body(endpoint)), { code: 'invalid_endpoint', field: 'endpoint' }, endpoint)
    }
  })

  it('알려진 푸시 서비스가 아닌 호스트 · 비슷한 이름으로 속이는 호스트 · IP · 끝 점은 push_service_not_allowed', () => {
    for (const endpoint of [
      'https://evil.example/fcm/send/x',
      'https://fcm.googleapis.com.evil.com/fcm/send/x',
      'https://evilfcm.googleapis.com/fcm/send/x',
      'https://googleapis.com/fcm/send/x',
      'https://evilpush.apple.com/x',
      'https://push.apple.com.attacker.net/x',
      'https://notify.windows.com.evil.com/w/',
      'https://evilnotify.windows.com/w/',
      'https://push.services.mozilla.com.evil.org/wpush/v2/x',
      'https://fcm.googleapis.com./fcm/send/x',
      'https://127.0.0.1/x',
      'https://142.250.1.1/fcm/send/x',
      'https://[::1]/x',
      'https://0x7f000001/x',
    ]) {
      assert.deepEqual(errorOf(body(endpoint)), { code: 'push_service_not_allowed', field: 'endpoint' }, endpoint)
    }
  })

  it('키: 없음 → missing_keys, p256dh는 base64url · 65바이트 · 0x04, auth는 base64url · 16바이트', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/keys'
    assert.deepEqual(errorOf({ endpoint }), { code: 'missing_keys', field: 'keys' })
    assert.deepEqual(errorOf({ endpoint, keys: 'x' }), { code: 'missing_keys', field: 'keys' })
    const p256 = Buffer.from(KEYS.p256dh, 'base64url')
    for (const p256dh of [undefined, 7, KEYS.p256dh.slice(0, -2), Buffer.from(p256).toString('base64'), Buffer.concat([Buffer.from([2]), p256.subarray(1, 33)]).toString('base64url'), `${KEYS.p256dh}AA`]) {
      assert.deepEqual(errorOf({ endpoint, keys: { ...KEYS, p256dh } }), { code: 'invalid_p256dh', field: 'keys.p256dh' }, String(p256dh))
    }
    for (const auth of [undefined, '', Buffer.alloc(15).toString('base64url'), Buffer.alloc(17).toString('base64url'), `${Buffer.alloc(16).toString('base64')}`]) {
      assert.deepEqual(errorOf({ endpoint, keys: { ...KEYS, auth } }), { code: 'invalid_auth', field: 'keys.auth' }, String(auth))
    }
  })

  it('해제 입력은 endpoint 문자열 · 길이만 본다(허용 목록 밖이어도 400이 아니라 "내 구독 없음"으로)', () => {
    assert.deepEqual(parsePushEndpoint({ endpoint: 'https://evil.example/x' }), { value: 'https://evil.example/x' })
    assert.deepEqual(parsePushEndpoint({}).error, { code: 'missing_endpoint', field: 'endpoint' })
    assert.deepEqual(parsePushEndpoint({ endpoint: 5 }).error, { code: 'invalid_endpoint', field: 'endpoint' })
    assert.deepEqual(parsePushEndpoint({ endpoint: `https://x/${'y'.repeat(MAX_ENDPOINT_LENGTH)}` }).error, { code: 'endpoint_too_long', field: 'endpoint' })
  })

  it('보내기 직전 다시 검사하는 함수도 같은 규칙: 허용 호스트의 https만 true', () => {
    assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/x'), true)
    for (const endpoint of ['http://web.push.apple.com/x', 'https://evil.example/x', 'https://127.0.0.1/x', 'https://u@web.push.apple.com/x', 'not a url', null]) {
      assert.equal(isAllowedPushEndpoint(endpoint), false, String(endpoint))
    }
  })
})
