-- 사용자에게 보이는 공지 (섹션 공지 등 사용자마다 다를 수 있음)
CREATE TABLE user_announcements (
  user_id BIGINT UNSIGNED NOT NULL,
  announcement_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, announcement_id),
  KEY idx_user_announcements_announcement (announcement_id),
  CONSTRAINT fk_user_announcements_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_announcements_announcement FOREIGN KEY (announcement_id) REFERENCES announcements (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
