-- 사용자별 앱 내 알림 = 변경 기록 (ADR 0009). 대상은 과제 또는 공지 하나(CHECK). 본문은 저장하지 않는다.
-- kind 값은 맨 뒤에만 추가. 시간 칼럼은 UTC. 사용자를 지우면 함께 지워지고, 공유 행 쪽 FK는 CASCADE가 아니다.
CREATE TABLE notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('assignment_created', 'assignment_due_changed', 'assignment_title_changed', 'assignment_removed',
    'announcement_created', 'announcement_updated') NOT NULL,
  assignment_id BIGINT UNSIGNED NULL,
  announcement_id BIGINT UNSIGNED NULL,
  before_due_at DATETIME(3) NULL,
  after_due_at DATETIME(3) NULL,
  before_title VARCHAR(255) NULL,
  after_title VARCHAR(255) NULL,
  detected_at DATETIME(3) NOT NULL,
  read_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_notifications_user_list (user_id, id),
  KEY idx_notifications_user_unread (user_id, read_at, id),
  KEY idx_notifications_merge_assignment (user_id, assignment_id, kind, read_at),
  KEY idx_notifications_merge_announcement (user_id, announcement_id, kind, read_at),
  KEY idx_notifications_assignment (assignment_id),
  KEY idx_notifications_announcement (announcement_id),
  CONSTRAINT chk_notifications_one_target CHECK ((assignment_id IS NULL) <> (announcement_id IS NULL)),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_assignment FOREIGN KEY (assignment_id) REFERENCES assignments (id),
  CONSTRAINT fk_notifications_announcement FOREIGN KEY (announcement_id) REFERENCES announcements (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
