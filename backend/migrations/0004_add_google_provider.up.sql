-- 값은 항상 맨 뒤에 추가한다 (ADR 0004). 다음 이메일 로그인은 'google' 뒤에 붙인다.
ALTER TABLE auth_identities MODIFY provider ENUM('kakao', 'google') NOT NULL
