-- 본 값이 있으면 되돌리지 않고 실패한다 (데이터 보존, ADR 0009)
BEGIN NOT ATOMIC
  IF EXISTS (SELECT 1 FROM user_assignments WHERE seen_title IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'user_assignments.seen_title에 값이 있어 되돌리지 않음 (데이터 보존)';
  END IF;
  ALTER TABLE user_assignments DROP COLUMN seen_title;
END
