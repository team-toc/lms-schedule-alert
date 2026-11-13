# backend

Node.js + Express API 서버. 카카오 로그인과 MariaDB 세션을 다룬다.

## 준비

- **Node.js 22 이상** (Node 20에서는 Windows에서 `argon2` 미리 빌드된 바이너리가 세그폴트로 죽고, `npm test`의 glob 패턴(`"test/**/*.test.js"`)은 Node 21부터만 동작한다)
- MariaDB (로컬 `127.0.0.1:3306`, 시간대 UTC · utf8mb4)
- 앱 전용 DB 계정과 DB 두 개(개발 · 테스트). 관리자 계정으로 한 번만 실행한다.

```sql
CREATE DATABASE lms_schedule_alert CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE lms_schedule_alert_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'lms_app'@'localhost' IDENTIFIED BY '비밀번호';
GRANT ALL PRIVILEGES ON lms_schedule_alert.* TO 'lms_app'@'localhost';
GRANT ALL PRIVILEGES ON lms_schedule_alert_test.* TO 'lms_app'@'localhost';
```

앱 계정에는 이 두 DB 권한만 준다.

## 실행

```bash
cd backend
cp .env.example .env   # 값 채우기 (아래 표)
npm install
npm run migrate        # 테이블 만들기
npm run dev
```

<http://localhost:4000/api/health> 에서 `{"ok":true,...}`가 보이면 된다.

`.env`는 커밋하지 않는다. 새 설정값이 생기면 `.env.example`에 이름만 추가한다. 필수 값이 비어 있으면 서버가 빠진 키 이름을 알려 주고 종료한다.

| 키 | 설명 |
| --- | --- |
| `DB_*` | 앱 전용 DB 계정 |
| `TEST_DB_NAME` | `npm test`용 DB. `_test`로 끝나고 개발 DB와 달라야 한다 |
| `SESSION_SECRET` | 32자 이상. `openssl rand -hex 32` |
| `SESSION_TTL_DAYS` | 세션 유지 기간(일). 요청마다 연장. 기본 7 |
| `FRONTEND_URL` | 로그인 후 돌아갈 프론트 주소 (개발: `http://localhost:5173`) |
| `KAKAO_REST_API_KEY` · `KAKAO_CLIENT_SECRET` | 카카오 디벨로퍼스 앱 키 · 클라이언트 시크릿 |
| `KAKAO_REDIRECT_URI` | 카카오 콘솔에 등록한 Redirect URI (개발: `http://localhost:4000/api/auth/kakao/callback`) |
| `NODE_ENV` | `production`이면 쿠키에 Secure |
| `TRUST_PROXY` | nginx 뒤에서 실행할 때 `true` (개발 `false`, 운영 `true`) |
| `CANVAS_BASE_URL` | 학교 Canvas 주소, 경로 없이 (운영은 https만). 서버 시작 때만 검사하고 마이그레이션에는 필요 없다 |
| `CANVAS_TOKEN_KEY` | Canvas 토큰 암호화 키. `openssl rand -base64 32` (32바이트 base64). **잃어버리면 저장된 토큰을 복구할 수 없다** |
| `LMS_SYNC_INTERVAL_MINUTES` | Canvas 주기 동기화 간격(분). 기본 30 |
| `LMS_SYNC_CONCURRENCY` | 동시에 도는 Canvas 동기화 수(첫 · 주기 · 수동 합계). 1 ~ 3, 기본 2 (DB 풀 10개를 API와 나눠 씀) |

## 마이그레이션

스키마는 `migrations/`의 `NNNN_이름.up.sql` / `.down.sql`로만 바꾼다. DB에 직접 SQL을 실행하지 않는다.

```bash
npm run migrate          # 남은 마이그레이션 적용
npm run migrate:status   # 적용된 것 / 남은 것
npm run migrate:down     # 마지막 하나 되돌리기
```

테이블 구조는 [docs/erd.md](docs/erd.md)에 있다. 마이그레이션을 추가하면 같은 커밋에서 ERD도 고친다.

### 되돌리기 전 확인할 것

- MariaDB의 `ALTER TABLE` · `CREATE TABLE` · `DROP TABLE`(DDL)은 실행 즉시 확정된다. 트랜잭션으로 묶을 수 없어서 **여러 단계를 한 번에 되돌리다 중간에 실패하면 앞 단계는 이미 되돌아간 상태로 남는다.**
- 되돌릴 값에 해당하는 데이터가 있으면 strict 모드가 막아서 그 단계에서 멈춘다(데이터를 지우거나 자르지 않기 위해 일부러 그렇게 둠).
  - `0004_add_google_provider` 되돌리기: `auth_identities`에 `provider = 'google'` 행이 있으면 실패
  - `0005_widen_provider_user_id` 되돌리기: `provider_user_id`가 64자를 넘는 행이 있으면 실패
- 되돌리기 전에 확인:

  ```sql
  SELECT COUNT(*) FROM auth_identities WHERE provider = 'google';
  SELECT COUNT(*) FROM auth_identities WHERE CHAR_LENGTH(provider_user_id) > 64;
  ```

- 중간에 멈췄다면 `npm run migrate:status`로 어디까지 되돌아갔는지 보고, `npm run migrate`로 남은 것을 다시 적용하면 원래(최신) 상태로 돌아온다. 되돌린 단계만 다시 적용되므로 데이터는 그대로다.

## 프론트엔드와 연동 (개발)

백엔드는 CORS를 열지 않는다. 운영에서는 nginx가 같은 도메인의 `/api`를 백엔드로 넘기므로, 개발에서도 프론트 개발 서버(Vite)의 프록시로 같은 방식을 쓴다. `frontend/vite.config.js`에 다음을 넣으면 프론트 코드는 `fetch('/api/auth/me')`처럼 상대 경로로 부르면 된다.

```js
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:4000' },
  },
})
```

- 로그인 버튼은 `window.location.href = '/api/auth/kakao'`로 이동한다(fetch 아님).
- 쿠키는 포트를 구분하지 않으므로 `localhost:4000`에서 받은 세션 쿠키가 `localhost:5173`에서도 쓰인다.

## API

모든 경로는 `/api` 아래에 둔다. nginx는 `/api` 규칙 하나로 백엔드를 프록시한다.

| 메서드 | 경로 | 응답 |
| --- | --- | --- |
| GET | `/api/health` | 서버 상태 |
| GET | `/api/auth/kakao` | 302 → 카카오 인가 페이지 (state를 세션에 저장) |
| GET | `/api/auth/kakao/callback` | 성공: 302 → `FRONTEND_URL` / 실패: 302 → `FRONTEND_URL/login/error?error=<코드>` |
| GET | `/api/auth/me` | 200 `{ id, displayName, onboardingStep }` / 401 `not_authenticated` |
| POST | `/api/auth/logout` | 204 / 401 `already_logged_out` |

콜백 실패 코드: `invalid_state`, `invalid_request`, `kakao_login_denied`, `kakao_api_failed`, `server_error`.

세션 쿠키 `sid`: httpOnly · SameSite=Lax · 운영에서 Secure, 기본 7일이고 요청마다 연장된다.

## 테스트 실행

```bash
npm test        # 전체 테스트
npm run lint    # 코드 규칙 검사
```

- 카카오 · Google · Canvas API는 가짜로 바꿔 실제로 호출하지 않는다. 테스트마다 테스트 DB의 테이블을 비우고, 테이블은 테스트가 마이그레이션으로 만든다.
- **`.env` 없이도 돈다.** 테스트는 환경에서 아래 DB 접속값만 읽고, 나머지 설정(세션 · 카카오 · Google 키, Canvas 주소 · 토큰 암호화 키, 프록시, 로그인 실패 제한 등)은 테스트 안에 고정돼 있다. `.env`가 있으면 거기 적힌 DB 접속값을 쓴다.

### 테스트 DB 준비

테스트 DB는 미리 만들어 두고, 테스트용 계정에 그 DB 권한(테이블 생성 · 삭제 · 변경 · 읽기 · 쓰기)을 준다.

```sql
CREATE DATABASE lms_schedule_alert_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON lms_schedule_alert_test.* TO '<테스트 계정>'@'localhost';
```

- 이름은 **`_test`로 끝나야 하고 개발 DB(`DB_NAME`)와 달라야 한다.** 아니면 테스트가 시작 전에 거부한다(개발 DB를 비우지 않도록).

### 환경변수

| 키 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `DB_USER` | 예 | — | 테스트 DB에 접속할 계정 |
| `DB_PASSWORD` | 예 | — | 그 계정의 비밀번호 |
| `DB_HOST` | 아니요 | `127.0.0.1` | |
| `DB_PORT` | 아니요 | `3306` | |
| `TEST_DB_NAME` | 아니요 | `lms_schedule_alert_test` | `_test`로 끝나야 함 |

```bash
# .env 없이 (예: CI)
DB_USER=... DB_PASSWORD=... npm test
```

### 주의

- `npm test`는 테스트 파일을 **하나씩** 실행한다(`--test-concurrency=1`). 모든 파일이 같은 테스트 DB를 쓰기 때문에 이 옵션을 바꾸거나 `node --test`를 병렬로 돌리지 말 것. 마이그레이션 테스트끼리 겹치면 하나가 "다른 테스트가 마이그레이션 중"으로 바로 실패한다.
- 같은 테스트 DB를 여러 곳(예: 동시에 도는 CI 잡 여러 개)에서 함께 쓰지 말 것.
- 테스트 DB가 꼬였으면(마이그레이션 기록이 어긋남 등) 테스트 DB만 비우고 0001부터 다시 적용한다. 이름이 `_test`로 끝나지 않거나 개발 DB와 같으면 거부한다.

  ```bash
  npm run test:db:reset
  ```

## 수동 테스트 (브라우저로 카카오 로그인)

준비: 카카오 디벨로퍼스 콘솔에서 카카오 로그인을 켜고, Redirect URI에 `KAKAO_REDIRECT_URI`와 같은 값을 등록하고, 동의항목은 닉네임만 켠다. 그다음 `npm run migrate && npm run dev`.

1. <http://localhost:4000/api/auth/kakao> 를 열고 카카오 로그인 · 동의를 한다.
2. `FRONTEND_URL`로 이동하면 성공. 프론트가 꺼져 있으면 연결 실패 화면이 뜨지만 로그인은 끝난 상태다.
3. <http://localhost:4000/api/auth/me> → `{"id":…,"displayName":"닉네임","onboardingStep":"lms_token"}`
4. 개발자도구 → Application → Cookies의 `sid`: HttpOnly · SameSite=Lax · 만료 약 7일 뒤 (개발에선 Secure 없음)
5. DB: `users`, `auth_identities`가 각 1행. 1번을 다시 해도 같은 `id`, 행 수 그대로.
6. 로그아웃: `localhost:4000` 탭 콘솔에서 `await fetch('/api/auth/logout', { method: 'POST' }).then(r => r.status)` → `204`. 이후 `/api/auth/me` → 401, 한 번 더 로그아웃 → `401`.
7. 동의 화면에서 취소 → `FRONTEND_URL/login/error?error=kakao_login_denied`
8. <http://localhost:4000/api/auth/kakao/callback?code=x&state=wrong> → `…/login/error?error=invalid_state`
9. 로그인한 채로 DB에서 그 사용자를 지우고 `/api/auth/me` → 401, `sessions` 행도 사라짐.
10. 서버 로그에 `code` · `state` 값이나 `sid` 값이 없고, `login_succeeded` · `login_failed`(이유 코드) 같은 이벤트만 있다.

## 구조

```text
src/
├─ index.js                  서버 시작 (설정 검증 → DB 풀 · 세션 저장소 · 카카오 클라이언트 조립)
├─ app.js                    Express 앱 구성 (로그 · 세션 · 라우트 · 에러 처리)
├─ config.js                 환경변수 검증
├─ logger.js                 JSON 로그 · 요청 ID
├─ session.js                express-session + MariaDB 세션 저장소
├─ auth/auth-routes.js       /api/auth/* 라우트
├─ accounts/account-service.js   계정 조회 · 생성 로직
├─ accounts/user-repository.js   users · auth_identities 접근 (경계 레이어)
├─ kakao/kakao-client.js     카카오 OAuth · 사용자 API 호출 (경계 레이어)
└─ db/                       커넥션 풀 · 마이그레이션 실행기
migrations/                  스키마 변경 SQL
scripts/migrate.js           마이그레이션 명령
test/                        테스트 (helpers/에 가짜 카카오 클라이언트 · 테스트 DB 도구)
```
