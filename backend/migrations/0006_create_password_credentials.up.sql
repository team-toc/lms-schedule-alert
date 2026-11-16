-- 이메일 로그인 비밀번호 해시. email_verified는 인증 메일 도입 전까지 항상 false (ADR 0007)
CREATE TABLE password_credentials (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  identity_id BIGINT UNSIGNED NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_credentials_identity (identity_id),
  CONSTRAINT fk_password_credentials_identity FOREIGN KEY (identity_id) REFERENCES auth_identities (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
