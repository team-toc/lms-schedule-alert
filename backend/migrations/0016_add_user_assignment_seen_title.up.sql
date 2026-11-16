-- 사용자가 마지막으로 본 과제 제목 (ADR 0009). 제목은 공유 행에만 있어, 먼저 동기화한 사용자가 바꾸면
-- 나중 사용자는 이전 값을 볼 수 없다 → 사용자별로 본 값을 두고 비교한다. NULL = 모름(알림 없이 채움)
ALTER TABLE user_assignments ADD COLUMN seen_title VARCHAR(255) NULL AFTER due_at
