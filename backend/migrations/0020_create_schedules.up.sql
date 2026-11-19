-- 사용자 일정 (ADR 0010): 앱에서 만든 일정(source = 'app')과 외부 캘린더에서 가져온 일정(icloud, 나중에 google · kakao)
-- 시각은 모두 UTC. 하루 종일 일정은 Asia/Seoul 자정 ~ 다음 자정의 UTC 범위 + is_all_day
-- 외부 일정: external_id = sha256(제공자 id + 회차 키) hex, 반복 일정은 회차마다 한 행. 원본에서 사라지면 deleted_at
-- 앱 일정은 연결 · external_id가 없고, 외부 일정은 둘 다 있다(CHECK). 사용자 · 연결을 지우면 함께 지워진다
-- 시작 = 끝(길이 0)은 허용한다: iCloud에 흔하고, 하나 때문에 그 연결의 동기화 전체가 실패하면 안 된다(겹침 판단에서는 뺀다)
-- source · status 값은 맨 뒤에만 추가
CREATE TABLE schedules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  calendar_link_id BIGINT UNSIGNED NULL,
  source ENUM('app', 'icloud', 'google', 'kakao') NOT NULL,
  external_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  title VARCHAR(255) NOT NULL,
  start_at DATETIME(3) NOT NULL,
  end_at DATETIME(3) NOT NULL,
  is_all_day BOOLEAN NOT NULL DEFAULT FALSE,
  status ENUM('confirmed', 'tentative', 'cancelled') NOT NULL DEFAULT 'confirmed',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_schedules_link_external (calendar_link_id, external_id),
  KEY idx_schedules_user_start (user_id, start_at),
  KEY idx_schedules_user_end (user_id, end_at),
  CONSTRAINT chk_schedules_time CHECK (start_at <= end_at),
  CONSTRAINT chk_schedules_source_link CHECK ((source = 'app') = (calendar_link_id IS NULL)),
  CONSTRAINT chk_schedules_source_external CHECK ((source = 'app') = (external_id IS NULL)),
  CONSTRAINT fk_schedules_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_schedules_calendar_link FOREIGN KEY (calendar_link_id) REFERENCES calendar_links (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
