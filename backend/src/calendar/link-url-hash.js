// 같은 링크 중복 등록 방지용 URL 해시 (ADR 0010 리뷰 결정 3).
// 정규화한 URL의 HMAC-SHA256(hex). 키 없는 해시는 링크 후보를 해시해 맞춰 볼 수 있어 쓰지 않는다.
// 키는 CANVAS_TOKEN_KEY에서 HKDF로 파생한다(암호화 키와 같은 바이트를 두 용도에 쓰지 않으려고).
import { createHmac, hkdfSync } from 'node:crypto'

const HKDF_INFO = 'calendar_link_url_hash/v1'
const DERIVED_KEY_BYTES = 32

export function createLinkUrlHasher({ key }) {
  const hmacKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), HKDF_INFO, DERIVED_KEY_BYTES))
  return (normalizedUrl) => createHmac('sha256', hmacKey).update(normalizedUrl, 'utf8').digest('hex')
}
