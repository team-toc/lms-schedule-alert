-- 64자를 넘는 값이 있으면 strict 모드에서 실패한다 (값을 자르지 않음)
ALTER TABLE auth_identities MODIFY provider_user_id VARCHAR(64) NOT NULL
