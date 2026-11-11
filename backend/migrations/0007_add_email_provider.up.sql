-- 값은 항상 맨 뒤에 추가한다 (ADR 0004)
ALTER TABLE auth_identities MODIFY provider ENUM('kakao', 'google', 'email') NOT NULL
