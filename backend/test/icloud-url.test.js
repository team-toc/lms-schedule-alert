import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIcloudUrl, isAllowedIcloudHost, MAX_URL_LENGTH } from '../src/calendar/icloud-url.js'

const TOKEN = 'MTAwMDAwURLtestTOKEN0000'
const CANONICAL = `https://p52-caldav.icloud.com/published/2/${TOKEN}`

// iCloud 공개 링크 검사 · 정규화 (ADR 0010 리뷰 결정 5): https로 바꾸고, 호스트는 정확히 icloud.com이거나 .icloud.com으로 끝날 때만
describe('iCloud URL 검사 · 정규화', () => {
  it('webcal:// → https://, 호스트 소문자, 기본 포트 · 쿼리 · 조각 · 앞뒤 공백 제거, 경로 대소문자는 그대로', () => {
    for (const input of [
      `webcal://p52-caldav.icloud.com/published/2/${TOKEN}`,
      CANONICAL,
      `WEBCAL://P52-CALDAV.ICLOUD.COM/published/2/${TOKEN}`,
      `https://p52-caldav.icloud.com:443/published/2/${TOKEN}`,
      `  ${CANONICAL}  `,
      `${CANONICAL}?share=1#frag`,
    ]) {
      assert.deepEqual(normalizeIcloudUrl(input), { url: CANONICAL }, input)
    }
  })

  it('정확히 icloud.com인 호스트도 된다', () => {
    assert.deepEqual(normalizeIcloudUrl('https://icloud.com/published/2/X'), { url: 'https://icloud.com/published/2/X' })
  })

  it('http는 insecure_url (iCloud 호스트여도)', () => {
    assert.deepEqual(normalizeIcloudUrl(`http://p52-caldav.icloud.com/published/2/${TOKEN}`), { error: 'insecure_url' })
  })

  it('비었거나 문자열이 아니면 missing_url, 너무 길면 url_too_long, URL이 아니거나 다른 스킴이면 invalid_url', () => {
    for (const input of [undefined, null, '', '   ', 123, {}]) {
      assert.deepEqual(normalizeIcloudUrl(input), { error: 'missing_url' }, String(input))
    }
    assert.deepEqual(normalizeIcloudUrl(`${CANONICAL}/${'a'.repeat(MAX_URL_LENGTH)}`), { error: 'url_too_long' })
    for (const input of ['not a url', 'ftp://p52-caldav.icloud.com/x', 'javascript:alert(1)', 'file:///etc/passwd', 'p52-caldav.icloud.com/published/2/x']) {
      assert.deepEqual(normalizeIcloudUrl(input), { error: 'invalid_url' }, input)
    }
  })

  it('iCloud가 아닌 호스트는 host_not_allowed: 문자열 포함 · 앞뒤 붙이기로 속이는 경우 모두', () => {
    for (const host of [
      'evilicloud.com',
      'icloud.com.evil.com',
      'p52-caldav.icloud.com.evil.com',
      'xicloud.com',
      'icloud.co',
      'icloud.com.',
      'p52-caldav.icloud.com.',
      'xn--cloud-0ze.com',
      'evil.com',
    ]) {
      assert.deepEqual(normalizeIcloudUrl(`https://${host}/published/2/x`), { error: 'host_not_allowed' }, host)
    }
    for (const input of [
      'https://іcloud.com/published/2/x',
      'https://evil.com/?.icloud.com',
      'https://evil.com/#.icloud.com',
      'https://evil.com/.icloud.com',
      'https://icloud.com@evil.com/published/2/x',
    ]) {
      assert.deepEqual(normalizeIcloudUrl(input), { error: 'host_not_allowed' }, input)
    }
  })

  it('계정 정보(user@ · user:pw@) · 443 외 포트 · IP 주소 · 내부 주소는 host_not_allowed', () => {
    for (const input of [
      `https://user@p52-caldav.icloud.com/published/2/${TOKEN}`,
      `https://user:pw@p52-caldav.icloud.com/published/2/${TOKEN}`,
      `https://p52-caldav.icloud.com:8443/published/2/${TOKEN}`,
      `https://p52-caldav.icloud.com:80/published/2/${TOKEN}`,
      `webcal://p52-caldav.icloud.com:8080/published/2/${TOKEN}`,
      'https://17.253.144.10/published/2/x',
      'https://127.0.0.1/published/2/x',
      'https://0x7f000001/published/2/x',
      'https://10.0.0.1/published/2/x',
      'https://192.168.0.10/published/2/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/published/2/x',
      'https://[fd00::1]/published/2/x',
      'https://localhost/published/2/x',
    ]) {
      assert.deepEqual(normalizeIcloudUrl(input), { error: 'host_not_allowed' }, input)
    }
  })

  it('isAllowedIcloudHost: 정확히 일치 또는 "." + icloud.com 접미사만 (소문자 기준)', () => {
    assert.equal(isAllowedIcloudHost('icloud.com'), true)
    assert.equal(isAllowedIcloudHost('p52-caldav.icloud.com'), true)
    assert.equal(isAllowedIcloudHost('a.b.icloud.com'), true)
    for (const host of ['evilicloud.com', 'icloud.com.evil.com', 'icloud.com.', '', 'ICLOUD.COM', '.icloud.com']) {
      assert.equal(isAllowedIcloudHost(host), false, host)
    }
  })
})
