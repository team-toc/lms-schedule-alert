-- 사용자에게 보이는 과제와 그 사용자 기준 마감(Canvas가 override를 반영해 준 due_at, UTC). 마감 없으면 NULL
CREATE TABLE user_assignments (
  user_id BIGINT UNSIGNED NOT NULL,
  assignment_id BIGINT UNSIGNED NOT NULL,
  due_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, assignment_id),
  KEY idx_user_assignments_user_due (user_id, due_at),
  KEY idx_user_assignments_assignment (assignment_id),
  CONSTRAINT fk_user_assignments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_assignments_assignment FOREIGN KEY (assignment_id) REFERENCES assignments (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
