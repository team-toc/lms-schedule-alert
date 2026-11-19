-- 브라우저 푸시 구독 (ADR 0012). endpoint와 브라우저 키 2개는 "그 브라우저로 알림을 보낼 수 있는 값"이라 원문을 두지 않는다:
-- subscription_enc = endpoint · p256dh · auth를 JSON으로 묶어 암호화(AES-256-GCM, AAD push_subscription:<user_id>)
-- endpoint_hash = endpoint의 HMAC-SHA256(CANVAS_TOKEN_KEY에서 HKDF로 파생한 키), 소문자 hex 64자
-- endpoint 하나에 한 행(사용자와 상관없이 UNIQUE): 같은 브라우저에서 다른 계정이 등록하면 행의 주인이 바뀐다
-- 계정 삭제 시 함께 지운다(CASCADE). Canvas 연동 해제와는 무관(users를 가리킴)
CREATE TABLE push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  endpoint_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subscription_enc VARCHAR(4096) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_success_at DATETIME(3) NULL,
  consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0,
  last_failure_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_subscriptions_endpoint (endpoint_hash),
  KEY idx_push_subscriptions_user (user_id, id),
  CONSTRAINT chk_push_subscriptions_endpoint_hash CHECK (endpoint_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT fk_push_subscriptions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
