-- Google sub 최대 255자, 다음 이메일 로그인에서 이메일(최대 254자)을 저장할 예정
ALTER TABLE auth_identities MODIFY provider_user_id VARCHAR(255) NOT NULL
