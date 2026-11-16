-- 사용자가 마지막으로 본 공지 제목 · 내용 해시 (ADR 0009). NULL = 모름(알림 없이 채움)
ALTER TABLE user_announcements
  ADD COLUMN seen_title VARCHAR(255) NULL AFTER announcement_id,
  ADD COLUMN seen_content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER seen_title
