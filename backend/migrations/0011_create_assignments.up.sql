-- Canvas 과제 (공유 행). 마감은 사용자마다 다를 수 있어 여기 두지 않고 user_assignments.due_at에 둔다 (ADR 0008)
-- deleted_at: 이 과제에 연결된 사용자가 하나도 남지 않은 시각. 행은 변경 감지(다음 단계)를 위해 남긴다
CREATE TABLE assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  course_id BIGINT UNSIGNED NOT NULL,
  canvas_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  html_url VARCHAR(2048) NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_assignments_course_canvas (course_id, canvas_id),
  CONSTRAINT fk_assignments_course FOREIGN KEY (course_id) REFERENCES courses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
