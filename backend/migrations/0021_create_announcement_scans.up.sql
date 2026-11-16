-- 사용자별로 어느 공지를 어느 내용(content_hash)까지 훑어 제안을 만들었는지 (ADR 0011). 바뀌지 않은 공지는 다시 훑지 않는다(멱등).
-- user_id는 lms_tokens(user_id)를 가리킨다: 연동 해제(토큰 행 삭제) · 사용자 삭제 때 같이 지워진다. 토큰 교체는 UPDATE라 남는다.
CREATE TABLE announcement_scans (
  user_id BIGINT UNSIGNED NOT NULL,
  announcement_id BIGINT UNSIGNED NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scanned_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, announcement_id),
  KEY idx_announcement_scans_announcement (announcement_id),
  CONSTRAINT fk_announcement_scans_token_user FOREIGN KEY (user_id) REFERENCES lms_tokens (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_announcement_scans_announcement FOREIGN KEY (announcement_id) REFERENCES announcements (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
