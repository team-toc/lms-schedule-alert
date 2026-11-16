-- 공지에서 뽑은 일정 제안 (ADR 0011). 사용자별 행 하나에 후보 내용 · 상태 · 수락해서 만든 앱 일정을 둔다.
-- candidate_key = sha256(시작 · 끝 · 하루 종일) hex, 종류는 넣지 않는다(종류 분류가 바뀌어도 같은 날짜는 한 제안). 같은 공지 · 같은 시각은 하나(UNIQUE).
-- status: pending(대기) · accepted · rejected. 만료(대기인데 시각이 지남)는 저장하지 않고 조회 때 계산한다. 값은 맨 뒤에만 추가
-- context: 왜 이 날짜인지 보여 줄 원문 앞뒤(앱에서 60자로 자름). 공지 본문 전체는 저장하지 않는다
-- user_id → lms_tokens(user_id) CASCADE: 연동 해제 · 사용자 삭제 때 제안도 지워지고, 만든 앱 일정(schedules)은 남는다(schedule_id 쪽만 끊김)
CREATE TABLE suggestions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  announcement_id BIGINT UNSIGNED NOT NULL,
  candidate_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('exam', 'cancellation', 'makeup', 'deadline', 'other') NOT NULL,
  start_at DATETIME(3) NOT NULL,
  end_at DATETIME(3) NOT NULL,
  is_all_day BOOLEAN NOT NULL DEFAULT FALSE,
  context VARCHAR(80) NOT NULL,
  status ENUM('pending', 'accepted', 'rejected') NOT NULL DEFAULT 'pending',
  schedule_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suggestions_user_announcement_candidate (user_id, announcement_id, candidate_key),
  KEY idx_suggestions_user_status (user_id, status, id),
  KEY idx_suggestions_announcement (announcement_id),
  KEY idx_suggestions_schedule (schedule_id),
  CONSTRAINT chk_suggestions_time CHECK (start_at < end_at),
  CONSTRAINT chk_suggestions_candidate_key CHECK (candidate_key REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT fk_suggestions_token_user FOREIGN KEY (user_id) REFERENCES lms_tokens (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_suggestions_announcement FOREIGN KEY (announcement_id) REFERENCES announcements (id),
  CONSTRAINT fk_suggestions_schedule FOREIGN KEY (schedule_id) REFERENCES schedules (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
