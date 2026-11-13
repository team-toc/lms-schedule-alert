-- 토큰 주인의 Canvas 계정 id(/api/v1/users/self의 id)와 "다음 동기화는 기준 동기화" 표시 (ADR 0009)
-- Canvas id는 64비트 정수라 2^53을 넘을 수 있다: JS Number · mysql2 BIGINT(Number로 읽음) 모두 정밀도를 잃으므로
-- 10진수 문자열로 저장하고 문자열로 비교한다(ascii_bin, 앞자리 0 없는 숫자만 CHECK).
-- 같은 Canvas 계정으로 재등록 · 교체하면 baseline_required를 그대로 두어 끊긴 동안의 변경도 알린다.
-- 기존 행은 계정 id가 없고 baseline_required = TRUE → 다음 동기화는 알림 없이 기준 값만 채운다.
ALTER TABLE lms_tokens
  ADD COLUMN canvas_user_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER user_id,
  ADD COLUMN baseline_required BOOLEAN NOT NULL DEFAULT TRUE AFTER status,
  ADD CONSTRAINT chk_lms_tokens_canvas_user_id CHECK (canvas_user_id REGEXP '^[1-9][0-9]{0,19}$')
