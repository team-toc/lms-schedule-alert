-- 계정 id가 저장된 행이 있으면 되돌리지 않고 실패한다 (데이터 보존, ADR 0009)
BEGIN NOT ATOMIC
  IF EXISTS (SELECT 1 FROM lms_tokens WHERE canvas_user_id IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'lms_tokens.canvas_user_id에 값이 있어 되돌리지 않음 (데이터 보존)';
  END IF;
  ALTER TABLE lms_tokens DROP CONSTRAINT chk_lms_tokens_canvas_user_id, DROP COLUMN canvas_user_id, DROP COLUMN baseline_required;
END
