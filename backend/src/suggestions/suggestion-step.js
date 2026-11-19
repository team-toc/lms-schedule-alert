// 공지 → 일정 제안 단계 (ADR 0011). Canvas 반영이 커밋된 뒤 afterApplied 훅으로, 같은 사용자 잠금 안에서 돈다.
// 훑은 기록과 "공지 내용 해시 + 추출기 버전"이 다른 공지만 다시 추출한다(변화 없는 재동기화는 0건).
// 추출기 버전(규칙 버전 상수 + 교시 시간표 내용)이 바뀌면 이미 훑은 공지도 다음 동기화에서 한 번 다시 분석된다(ADR 0011, 2026-11-19).
// 훑은 기록의 content_hash 칸(CHAR(64) hex)에 sha256(공지 content_hash | 추출기 버전)을 저장한다(마이그레이션 없음). 추출이 던지면 그 공지만 건너뛰고
// 훑은 기록을 남기지 않아 다음 동기화에서 다시 시도한다. 로그에는 개수 · 에러 이름 · 코드만(본문 · 맥락 · 제목 · 메시지 없음)
import { createHash } from 'node:crypto'
import { htmlToText } from './announcement-text.js'
import { selectCandidates } from './suggestion-policy.js'
import { createSuggestionSyncRepository } from './suggestion-sync-repository.js'

function extractOrNull({ extractor, logger }, userId, row, at) {
  try {
    // 제목은 본문 앞 한 줄로도 넣는다("[휴강] 11/20(금) 휴강"처럼 제목에만 날짜가 있는 공지). 본문과 같은 날짜는 후보 키로 하나가 된다
    const text = [row.title, htmlToText(row.body)].filter(Boolean).join('\n')
    return extractor.extract({ title: row.title, text, postedAt: row.posted_at ?? at })
  } catch (err) {
    logger.warn({ event: 'suggestion_extract_failed', userId, announcementId: row.id, err: { name: err?.name, code: err?.code } }, 'suggestion extract failed')
    return null
  }
}

// 버전이 없는 추출기(테스트에서 바꿔 끼운 것 등)는 공지 해시 그대로(예전과 같은 판단)
const scanKeyOf = (contentHash, version) => (version ? createHash('sha256').update(`${contentHash}|${version}`).digest('hex') : contentHash)

export function createSuggestionStep({ pool, logger, extractor }) {
  const repository = createSuggestionSyncRepository(pool, { logger })

  return async function runSuggestionStep({ userId, at }) {
    const totals = { scanned: 0, failed: 0, created: 0, updated: 0, removed: await repository.removeUnlinked(userId) }
    // 동기화마다 버전을 읽는다(서버 재시작으로 시간표 · 규칙이 바뀐 뒤 첫 동기화에서 다시 분석)
    const version = extractor.version
    for (const row of await repository.listScanTargets(userId)) {
      const scanKey = scanKeyOf(row.content_hash, version)
      if (row.scanned_hash === scanKey) {
        continue
      }
      const extracted = extractOrNull({ extractor, logger }, userId, row, at)
      if (extracted === null) {
        totals.failed += 1
        continue
      }
      const counts = await repository.applyCandidates({ userId, announcementId: row.id, contentHash: scanKey, at }, selectCandidates(extracted, at))
      totals.scanned += 1
      totals.created += counts.created
      totals.updated += counts.updated
      totals.removed += counts.removed
    }
    logger.info({ event: 'suggestions_scanned', userId, ...totals }, 'suggestions scanned')
  }
}
