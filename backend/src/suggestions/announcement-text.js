// 공지 본문 HTML → 추출용 글자 (ADR 0011). 렌더링 · 스크립트 실행 없이 문자열만 다룬다.
// 순서: 글자째 버릴 요소 → 블록 태그는 줄바꿈 → 나머지 태그 제거 → 엔티티 한 번 해석(해석한 결과는 다시 태그로 보지 않음)
const DROPPED = /<!--[\s\S]*?(?:-->|$)|<(script|style|head|template|noscript|title)\b[\s\S]*?(?:<\/\1\s*>|$)/gi
// 속성 값 안의 '>'도 태그 안으로 본다
const TAG_BODY = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`
const BLOCK_TAG = new RegExp(String.raw`<\/?(?:p|div|li|ul|ol|br|hr|tr|table|thead|tbody|h[1-6]|section|article|header|footer|blockquote|pre|dl|dt|dd)\b${TAG_BODY}>`, 'gi')
const CELL_TAG = new RegExp(String.raw`<\/?(?:td|th)\b${TAG_BODY}>`, 'gi')
const ANY_TAG = new RegExp(String.raw`<\/?[A-Za-z][A-Za-z0-9-]*${TAG_BODY}>`, 'g')
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]+));/g
const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntity(raw, dec, hex, name) {
  if (name !== undefined) {
    return Object.hasOwn(NAMED, name) ? NAMED[name] : raw
  }
  const code = dec !== undefined ? Number(dec) : parseInt(hex, 16)
  const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
  return valid ? String.fromCodePoint(code) : raw
}

export function htmlToText(html) {
  if (typeof html !== 'string' || html === '') {
    return ''
  }
  const stripped = html.replace(DROPPED, ' ').replace(BLOCK_TAG, '\n').replace(CELL_TAG, ' ').replace(ANY_TAG, '')
  const decoded = stripped.replace(ENTITY, decodeEntity)
  return decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}
