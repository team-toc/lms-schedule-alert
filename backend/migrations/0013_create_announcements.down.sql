-- 행이 있으면 되돌리지 않고 실패한다 (데이터 보존, ADR 0008). 비어 있을 때만 테이블을 지운다.
BEGIN NOT ATOMIC
  IF EXISTS (SELECT 1 FROM announcements) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'announcements 테이블에 행이 있어 되돌리지 않음 (데이터 보존)';
  END IF;
  DROP TABLE announcements;
END
