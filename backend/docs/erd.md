# ERD (백엔드 DB)

현재 마이그레이션(`migrations/0001` ~ `0007`) 기준으로 **실제로 있는 테이블만** 그린다. 마이그레이션을 추가하면 같은 커밋에서 이 문서도 고친다. 아직 만들지 않은 캘린더 · LMS 테이블은 넣지 않는다.

- 문자셋 utf8mb4, 시간 칼럼은 UTC로 저장 (`DATETIME(3)`, 밀리초까지)
- 마이그레이션 실행 기록 `schema_migrations`는 도구의 장부라 그리지 않는다

```mermaid
erDiagram
    users ||--o{ auth_identities : "로그인 수단 (ON DELETE CASCADE)"
    auth_identities ||--o| password_credentials : "이메일 로그인 비밀번호 (ON DELETE CASCADE)"

    users {
        bigint_unsigned id PK "AUTO_INCREMENT"
        varchar(100) display_name "NOT NULL, 공백 정리 · 비면 '사용자'"
        enum onboarding_step "NOT NULL, 'lms_token' | 'done', 기본 'lms_token'"
        datetime(3) created_at "NOT NULL, 기본 현재 시각"
        datetime(3) updated_at "NOT NULL, 행이 바뀌면 자동 갱신"
    }

    auth_identities {
        bigint_unsigned id PK "AUTO_INCREMENT"
        bigint_unsigned user_id FK "NOT NULL → users.id"
        enum provider UK "NOT NULL, 'kakao' | 'google' | 'email' (값은 맨 뒤에만 추가)"
        varchar(255) provider_user_id UK "NOT NULL, 카카오 회원번호 · Google sub · 정규화된 이메일"
        datetime(3) created_at "NOT NULL, 기본 현재 시각"
    }

    password_credentials {
        bigint_unsigned id PK "AUTO_INCREMENT"
        bigint_unsigned identity_id FK "NOT NULL, UNIQUE → auth_identities.id (provider = 'email')"
        varchar(255) password_hash "NOT NULL, argon2id 해시 문자열 (원문 저장 안 함)"
        boolean email_verified "NOT NULL, 기본 false (인증 메일 도입 전까지 항상 false)"
        datetime(3) created_at "NOT NULL, 기본 현재 시각"
        datetime(3) updated_at "NOT NULL, 행이 바뀌면 자동 갱신"
    }

    sessions {
        varchar(128) session_id PK "utf8mb4_bin"
        int_unsigned expires "NOT NULL, 만료 시각(유닉스 초), 인덱스"
        mediumtext data "세션 JSON (userId, 로그인 중인 state 등)"
    }
```

## 키 · 인덱스

| 테이블 | 이름 | 종류 | 칼럼 |
| --- | --- | --- | --- |
| users | PRIMARY | PK | `id` |
| auth_identities | PRIMARY | PK | `id` |
| auth_identities | `uq_auth_identities_provider_user` | UNIQUE (복합) | `provider`, `provider_user_id` |
| auth_identities | `idx_auth_identities_user_id` | 인덱스 | `user_id` |
| auth_identities | `fk_auth_identities_user` | FK | `user_id` → `users.id`, ON DELETE CASCADE |
| password_credentials | PRIMARY | PK | `id` |
| password_credentials | `uq_password_credentials_identity` | UNIQUE | `identity_id` (로그인 수단 하나에 비밀번호 하나) |
| password_credentials | `fk_password_credentials_identity` | FK | `identity_id` → `auth_identities.id`, ON DELETE CASCADE |
| sessions | PRIMARY | PK | `session_id` |
| sessions | `idx_sessions_expires` | 인덱스 | `expires` (만료 세션 정리용) |

## 메모

- 한 사용자에 로그인 수단 여러 개(1:N). 같은 사람이라도 제공자가 다르면 지금은 별개 계정이다(계정 연결은 범위 밖).
- `UNIQUE(provider, provider_user_id)`: 같은 제공자의 같은 계정은 한 번만 등록된다. 동시 가입 때 중복을 막는 장치. 제공자가 다르면 같은 id 값도 다른 행이다.
- 이메일 로그인은 `auth_identities`(provider `email`, 이메일)와 `password_credentials`(해시)로 나눠 저장한다. `users`에는 이메일 · 비밀번호 칼럼이 없다. 비밀번호 행은 email identity에만 붙는다(0..1).
- `sessions`는 `users`와 외래키로 묶여 있지 않다(세션 라이브러리 스키마). 사용자가 지워지면 `/api/auth/me` · `/logout`에서 확인해 세션을 지운다.
- `provider` ENUM 변경 이력: `('kakao')` → 0004 `('kakao', 'google')` → 0007 `('kakao', 'google', 'email')`.
- `provider_user_id` 길이 이력: `VARCHAR(64)` → 0005 `VARCHAR(255)` (Google sub 최대 255자, 이메일 최대 254자).
- 되돌리기 순서 보호: 0006에서 테이블을 만들고 0007에서 ENUM을 바꿨다. 되돌릴 때 0007이 먼저 실행되므로 email 행이 있으면 거기서 멈추고, `password_credentials`(비밀번호 해시)는 지워지지 않는다.
