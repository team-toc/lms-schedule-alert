import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText } from '../src/suggestions/announcement-text.js'

// 공지 본문 HTML → 추출용 글자 (ADR 0011): 태그 제거 · 엔티티 해석, 렌더링 · 스크립트 실행 없음
describe('공지 본문 HTML → 텍스트', () => {
  it('블록 태그(p · div · li · br · tr · h1 ~ h6)는 줄바꿈, 나머지 태그는 지우고 글자만', () => {
    const text = htmlToText('<h2>중간고사 안내</h2><p>일시: <b>11월 20일</b> 오후 2시</p><ul><li>장소: 공학관</li><li>준비물: 학생증</li></ul>둘째 줄<br>셋째 줄')

    assert.deepEqual(text.split('\n').map((l) => l.trim()).filter(Boolean), ['중간고사 안내', '일시: 11월 20일 오후 2시', '장소: 공학관', '준비물: 학생증', '둘째 줄', '셋째 줄'])
  })

  it('엔티티: &nbsp; · &amp; · &lt; · &gt; · &quot; · &#39; · &#x2F; · &#65;는 글자로, 모르는 엔티티는 그대로', () => {
    assert.equal(htmlToText('A&nbsp;B &amp; &lt;b&gt; &quot;q&quot; it&#39;s 11&#x2F;20 &#65; &foo;'), 'A B & <b> "q" it\'s 11/20 A &foo;')
  })

  it('script · style · 주석 · head 안의 글자는 버린다 (실행 · 렌더링 없이)', () => {
    const text = htmlToText('<head><title>11월 1일</title></head><style>.x{content:"11월 2일"}</style><script>alert("11월 3일")</script><!-- 11월 4일 -->본문 11월 5일')

    assert.equal(text.trim(), '본문 11월 5일')
  })

  it('태그 속성(href · data-*) 안의 숫자는 글자에 들어오지 않는다', () => {
    assert.equal(htmlToText('<a href="https://x.test/2026-11-20" data-due="11/21">링크</a>').trim(), '링크')
  })

  it('엔티티로 만든 태그 모양은 태그가 아니라 글자로 남는다 (다시 해석하지 않음)', () => {
    assert.equal(htmlToText('&lt;script&gt;11월 6일&lt;/script&gt;').trim(), '<script>11월 6일</script>')
  })

  it('null · undefined · 빈 문자열 → 빈 문자열, 연속 공백은 하나로', () => {
    assert.equal(htmlToText(null), '')
    assert.equal(htmlToText(undefined), '')
    assert.equal(htmlToText(''), '')
    assert.equal(htmlToText('<p>a   \t b</p>').trim(), 'a b')
  })
})
