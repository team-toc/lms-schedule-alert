-- 본 값이 있으면 되돌리지 않고 실패한다 (데이터 보존, ADR 0009)
BEGIN NOT ATOMIC
  IF EXISTS (SELECT 1 FROM user_announcements WHERE seen_title IS NOT NULL OR seen_content_hash IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'user_announcements의 본 값에 값이 있어 되돌리지 않음 (데이터 보존)';
  END IF;
  ALTER TABLE user_announcements DROP COLUMN seen_title, DROP COLUMN seen_content_hash;
END
