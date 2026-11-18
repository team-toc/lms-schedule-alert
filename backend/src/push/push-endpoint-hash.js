// 같은 브라우저 구독 중복 확인용 endpoint 해시 (ADR 0012, iCloud 링크와 같은 방식).
// endpoint 문자열의 HMAC-SHA256(hex). 키 없는 해시는 endpoint 후보를 해시해 맞춰 볼 수 있어 쓰지 않는다.
// 키는 CANVAS_TOKEN_KEY에서 HKDF로 파생한다(용도 이름이 달라 링크 해시 키와도 다르다).
import { createHmac, hkdfSync } from 'node:crypto'

const HKDF_INFO = 'push_endpoint_hash/v1'
const DERIVED_KEY_BYTES = 32

export function createPushEndpointHasher({ key }) {
  const hmacKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), HKDF_INFO, DERIVED_KEY_BYTES))
  return (endpoint) => createHmac('sha256', hmacKey).update(endpoint, 'utf8').digest('hex')
}
