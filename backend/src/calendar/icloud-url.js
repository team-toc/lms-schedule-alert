// iCloud 공개 캘린더 링크 검사 · 정규화 (ADR 0010 리뷰 결정 5). 서버가 임의 주소로 요청하지 않게(SSRF) 하는 첫 관문.
// - webcal:// → https://, http는 거부(insecure_url)
// - 호스트는 정확히 icloud.com이거나 .icloud.com으로 끝날 때만(소문자 URL.hostname 기준, 문자열 포함 검사 금지)
// - 계정 정보(user@) · 443 외 포트 · IP 주소 · localhost는 거부
// - 정규화: https + 소문자 호스트 + 경로(쿼리 · 조각 · 기본 포트 제거). 같은 링크 중복 판단과 요청에 이 값을 쓴다
// 결과에 원문을 되돌려 주는 에러 메시지는 없다(코드만).
export const MAX_URL_LENGTH = 1024
const ICLOUD_DOMAIN = 'icloud.com'
const ICLOUD_SUFFIX = `.${ICLOUD_DOMAIN}`
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const WEBCAL_PREFIX = /^webcal:\/\//i

// host: URL.hostname(소문자). 하위 도메인은 DNS 라벨만(빈 라벨 · 끝 점 거부)
export function isAllowedIcloudHost(host) {
  if (typeof host !== 'string') {
    return false
  }
  if (host === ICLOUD_DOMAIN) {
    return true
  }
  if (!host.endsWith(ICLOUD_SUFFIX)) {
    return false
  }
  return host
    .slice(0, -ICLOUD_SUFFIX.length)
    .split('.')
    .every((label) => DNS_LABEL.test(label))
}

// 파싱된 https URL이 요청해도 되는 iCloud 주소인지 (리다이렉트 대상 검사에도 같은 규칙)
export function isAllowedIcloudUrl(url) {
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' && isAllowedIcloudHost(url.hostname)
}

function parse(raw) {
  try {
    // webcal은 특수 스킴이 아니라 호스트를 정규화하지 않으므로, https로 바꾼 뒤 파싱한다(소문자 · 퓨니코드 · IPv4 정규화)
    return new URL(raw.replace(WEBCAL_PREFIX, 'https://'))
  } catch {
    return null
  }
}

// 결과: { url: 정규화한 https 문자열 } | { error: 'missing_url' | 'url_too_long' | 'invalid_url' | 'insecure_url' | 'host_not_allowed' }
export function normalizeIcloudUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { error: 'missing_url' }
  }
  const raw = input.trim()
  if (raw.length > MAX_URL_LENGTH) {
    return { error: 'url_too_long' }
  }
  const url = parse(raw)
  if (!url) {
    return { error: 'invalid_url' }
  }
  if (url.protocol === 'http:') {
    return { error: 'insecure_url' }
  }
  if (url.protocol !== 'https:') {
    return { error: 'invalid_url' }
  }
  if (!isAllowedIcloudUrl(url)) {
    return { error: 'host_not_allowed' }
  }
  return { url: `https://${url.hostname}${url.pathname}` }
}
