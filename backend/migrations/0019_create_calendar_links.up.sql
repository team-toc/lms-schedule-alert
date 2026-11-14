-- 사용자의 외부 캘린더 연결 (ADR 0010). 이번에는 provider = 'icloud'(공개 캘린더 링크)만 쓴다. 값은 맨 뒤에만 추가
-- url_enc: 링크 원문의 AES-256-GCM 암호문(토큰과 같은 키, AAD로 용도 구분). 원문 · 일부는 저장하지 않는다
-- url_hash: 정규화한 URL의 HMAC-SHA256(hex, 키는 CANVAS_TOKEN_KEY에서 HKDF로 파생). 같은 링크 중복 등록 방지용
-- sync_status: syncing(첫 동기화 전) · ok · failing(재시도 대상) · invalid(링크가 무효, 주기 실행 제외). 사용자당 개수 상한은 앱(5개)
CREATE TABLE calendar_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  provider ENUM('icloud', 'google', 'kakao') NOT NULL,
  url_enc VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  url_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sync_status ENUM('syncing', 'ok', 'failing', 'invalid') NOT NULL DEFAULT 'syncing',
  last_synced_at DATETIME(3) NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_calendar_links_user_url (user_id, url_hash),
  KEY idx_calendar_links_sync_targets (sync_status, last_synced_at),
  CONSTRAINT chk_calendar_links_url_hash CHECK (url_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT fk_calendar_links_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
