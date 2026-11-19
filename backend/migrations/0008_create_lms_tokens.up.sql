-- 사용자별 Canvas 개인 액세스 토큰(AES-256-GCM 암호문)과 동기화 상태 (ADR 0008)
-- status: syncing(첫 동기화 전) · ok · failing(재시도 대상) · needs_reauth(401, 주기 실행 제외). 값은 맨 뒤에만 추가
CREATE TABLE lms_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_enc VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('syncing', 'ok', 'failing', 'needs_reauth') NOT NULL DEFAULT 'syncing',
  connected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_synced_at DATETIME(3) NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lms_tokens_user (user_id),
  CONSTRAINT fk_lms_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
