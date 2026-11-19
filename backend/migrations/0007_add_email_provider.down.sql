-- email 행이 남아 있으면 strict 모드에서 실패한다 (데이터를 지우지 않음)
ALTER TABLE auth_identities MODIFY provider ENUM('kakao', 'google') NOT NULL
