# 백엔드 API 설명서

프론트엔드 연동용. 실제 코드(`src/app.js`, `src/auth/*`, `src/email/email-input.js`, `src/lms/*`, `src/calendar/*`) 기준으로 쓴다. 라우트를 추가 · 변경하는 커밋에서 이 문서도 같이 고친다(`test/api-doc.test.js`가 문서에 없는 라우트를 잡는다).

- [1. 공통 사항](#1-공통-사항)
- [2. 엔드포인트](#2-엔드포인트)
- [3. 소셜 로그인 흐름](#3-소셜-로그인-흐름)
- [4. onboarding_step 사용법](#4-onboarding_step-사용법)
- [5. 에러 코드 전체 표](#5-에러-코드-전체-표)
- [6. 알려진 동작](#6-알려진-동작)
- [7. 프론트와 정해야 할 것](#7-프론트와-정해야-할-것)

## 1. 공통 사항

### 기본 경로

모든 API는 `/api` 아래에 있다. 운영에서는 nginx가 같은 도메인의 `/api`를 백엔드로 넘긴다.

### 인증: 세션 쿠키

| 항목 | 값 |
| --- | --- |
| 쿠키 이름 | `sid` |
| 속성 | `HttpOnly`, `SameSite=Lax`, `Path=/`, 운영(HTTPS)에서는 `Secure` |
| 유지 기간 | 7일. 요청이 있을 때마다 다시 7일로 연장(rolling) |
| 발급 시점 | 로그인 · 가입 성공 시 새 세션 ID로 발급. 소셜 로그인 시작(`/api/auth/kakao`, `/api/auth/google`) 때도 로그인 전 세션이 만들어진다 |

- `HttpOnly`라 프론트 JavaScript에서 쿠키를 읽을 수 없다. **로그인 여부는 `GET /api/auth/me`로 확인**한다.
- 토큰을 저장하거나 `Authorization` 헤더를 붙일 필요가 없다. 브라우저가 쿠키를 자동으로 보낸다.

### 프론트에서 요청하는 법

같은 출처(프론트와 API가 같은 도메인 · 포트)로 상대 경로를 부른다. `fetch` 기본값(`credentials: 'same-origin'`)으로 쿠키가 붙는다.

```js
// 로그인 상태 확인
const res = await fetch('/api/auth/me')
if (res.status === 401) {
  // 로그인 화면으로
}
const user = await res.json() // { id, displayName, onboardingStep }

// JSON 본문을 보내는 요청
const login = await fetch('/api/auth/email/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
```

### 개발 중: 프론트 개발 서버 프록시 (CORS는 열지 않음)

백엔드는 CORS를 열지 않는다. 개발 중에는 Vite 개발 서버가 `/api`를 백엔드(`http://localhost:4000`)로 넘기게 해서 같은 출처를 만든다. `frontend/vite.config.js`:

```js
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:4000' },
  },
})
```

- 프론트 코드는 `http://localhost:4000`을 직접 쓰지 말고 `/api/...` 상대 경로만 쓴다.
- 쿠키는 포트를 구분하지 않으므로, 소셜 로그인 콜백(백엔드 `localhost:4000`)에서 받은 `sid`가 `localhost:5173`에서도 쓰인다.

### JSON 요청

- 본문이 있는 요청은 `Content-Type: application/json`으로 보낸다(`; charset=utf-8`이 붙어도 된다).
- 이메일 가입 · 로그인은 JSON이 아니면 **415** `unsupported_media_type`으로 거부한다(다른 사이트의 폼 POST 차단).
- 문자셋은 UTF-8만 받는다. 다른 문자셋(예: `charset=iso-8859-1`)은 **415** `unsupported_charset`.
- `Content-Encoding`은 없음(`identity`) · `gzip` · `deflate`만 받는다. 그 밖은 **415** `unsupported_encoding`. 브라우저 `fetch`는 기본으로 붙이지 않으므로 보통 신경 쓸 필요 없다.
- 본문 크기 한도는 **100KB**. 넘으면 **413** `payload_too_large`.

### 공통 응답 형식

모든 JSON 에러 응답은 아래 모양이다. 입력 검증 에러(400)에만 `field`가, 서버 오류(500)에만 `requestId`가 붙는다.

```json
{ "error": "에러_코드", "message": "사용자에게 보여 줄 수 있는 한국어 문장" }
```

```json
{ "error": "invalid_email", "field": "email", "message": "이메일 형식이 올바르지 않습니다." }
```

```json
{ "error": "internal_error", "message": "서버 오류가 발생했습니다.", "requestId": "6d274bbb-a9d6-4a43-8267-293323c049ab" }
```

- 프론트는 `error` 값으로 분기하고, `message`는 그대로 보여 줘도 된다.
- 모든 응답에 `X-Request-Id` 헤더가 붙는다. 버그를 알릴 때 이 값을 같이 주면 서버 로그를 찾을 수 있다.

### 상태 코드

| 상태 | 언제 | 어느 API |
| --- | --- | --- |
| 200 | 성공(본문 있음) | `/me`, 이메일 로그인, health, Canvas 상태, 캘린더 |
| 201 | 이메일 가입 성공 | 이메일 가입 |
| 202 | 받아들였고 나머지는 백그라운드에서 처리 | Canvas 토큰 등록 · 수동 동기화 |
| 204 | 성공(본문 없음) | 로그아웃 · Canvas 연동 해제 |
| 302 | 리다이렉트 | 소셜 로그인 시작 · 콜백 |
| 400 `invalid_json` | `Content-Type: application/json`인데 본문이 올바른 JSON이 아니거나, 맨 바깥이 객체 · 배열이 아님(`null` 등) | JSON 본문을 받는 모든 API |
| 400 (검증) | 입력 검증 실패. `field`로 어느 항목인지 알려 준다 | 이메일 가입 · 로그인, Canvas 토큰 등록, 캘린더 |
| 401 | 로그인 안 됨 / 이미 로그아웃됨 / 이메일 · 비밀번호 틀림 (API마다 `error`가 다름) | `/me`, 로그아웃, 이메일 로그인, `/api/lms/*` · `/api/calendar/*` 전체 |
| 404 `not_found` | `/api` 아래 없는 경로, 또는 있는 경로에 잘못된 메서드(예: `GET /api/auth/logout`). 405로 나누지 않는다 | `/api` 전체 |
| 404 `lms_not_connected` | Canvas를 연결하지 않았는데 해제 · 동기화를 요청 | Canvas 연동 해제 · 수동 동기화 |
| 409 | 이미 가입된 이메일 / Canvas 토큰을 다시 등록해야 함 | 이메일 가입, 수동 동기화 |
| 413 `payload_too_large` | 본문이 100KB를 넘음 | 본문을 받는 모든 API |
| 415 `unsupported_media_type` | JSON이 아닌 요청 | 이메일 가입 · 로그인, Canvas 토큰 등록 |
| 415 `unsupported_charset` · `unsupported_encoding` | JSON 본문의 문자셋이 UTF-8이 아님 · 지원하지 않는 `Content-Encoding` | JSON 본문을 받는 모든 API |
| 429 | 로그인 실패 횟수 초과 / 수동 동기화 5분 제한. `Retry-After` 헤더(초) | 이메일 로그인, 수동 동기화 |
| 500 | 서버 오류. `requestId` 포함 | 모든 JSON API |
| 502 · 503 · 504 | Canvas 쪽 문제(연결 실패 · 요청 한도 초과 · 응답 지연). 잠시 후 다시 시도 | Canvas 토큰 등록 |

## 2. 엔드포인트

| 메서드 | 경로 | 로그인 필요 | 요약 |
| --- | --- | --- | --- |
| GET | `/api/health` | 아니요 | 서버 상태 |
| GET | `/api/auth/me` | 예 | 로그인한 사용자 정보 |
| POST | `/api/auth/logout` | 예 | 로그아웃 |
| POST | `/api/auth/email/signup` | 아니요 | 이메일 가입(가입하면 바로 로그인) |
| POST | `/api/auth/email/login` | 아니요 | 이메일 로그인 |
| GET | `/api/auth/kakao` | 아니요 | 카카오 로그인 시작(브라우저 이동) |
| GET | `/api/auth/kakao/callback` | 아니요 | 카카오가 부르는 콜백(프론트는 부르지 않음) |
| GET | `/api/auth/google` | 아니요 | Google 로그인 시작(브라우저 이동) |
| GET | `/api/auth/google/callback` | 아니요 | Google이 부르는 콜백(프론트는 부르지 않음) |
| POST | `/api/lms/token` | 예 | Canvas 토큰 등록(교체) + 첫 동기화 시작 |
| DELETE | `/api/lms/token` | 예 | Canvas 연동 해제(토큰 · 내 연결 삭제) |
| GET | `/api/lms/status` | 예 | Canvas 연동 · 동기화 상태 |
| POST | `/api/lms/sync` | 예 | 지금 동기화(5분에 한 번) |
| GET | `/api/calendar/events` | 예 | 기간 안의 내 과제 마감 + 앱 일정 + 가져온(iCloud) 일정 |
| GET | `/api/calendar/conflicts` | 예 | 기간 안의 겹치는 일정 쌍 |
| POST | `/api/calendar/schedules` | 예 | 앱 일정 만들기 |
| PATCH | `/api/calendar/schedules/:id` | 예 | 앱 일정 수정 |
| DELETE | `/api/calendar/schedules/:id` | 예 | 앱 일정 삭제 |
| POST | `/api/calendar/links/icloud` | 예 | iCloud 공개 캘린더 링크 등록 + 첫 동기화 시작 |
| GET | `/api/calendar/links` | 예 | 내 외부 캘린더 연결 목록 · 상태 |
| DELETE | `/api/calendar/links/:id` | 예 | 연결 삭제(그 연결의 일정도) |
| POST | `/api/calendar/links/:id/sync` | 예 | 지금 동기화(연결별 5분에 한 번) |
| GET | `/api/notifications` | 예 | 내 알림(Canvas 변경) 목록, 최신순 |
| POST | `/api/notifications/read-all` | 예 | 내 알림 전부 읽음 |
| POST | `/api/notifications/:id/read` | 예 | 알림 하나 읽음 |

### GET /api/health

서버가 떠 있는지 확인한다. 로그인 필요 없음.

- 성공 **200**

  ```json
  { "ok": true, "time": "2026-11-09T01:04:39.704Z" }
  ```

### GET /api/auth/me

로그인한 사용자 정보. 앱을 열 때 이걸로 로그인 여부와 다음 화면을 정한다([4. onboarding_step 사용법](#4-onboarding_step-사용법)).

- 요청: 본문 · 쿼리 없음. `sid` 쿠키(브라우저가 자동으로 보냄)
- 성공 **200**

  ```json
  { "id": 3, "displayName": "홍길동", "onboardingStep": "lms_token" }
  ```

  | 필드 | 타입 | 설명 |
  | --- | --- | --- |
  | `id` | number | 사용자 id |
  | `displayName` | string | 표시 이름(1 ~ 100자). 소셜 닉네임 · 가입 때 입력한 이름, 없으면 `사용자` |
  | `onboardingStep` | `"lms_token"` \| `"done"` | 가입 직후는 `lms_token` |

- 실패

  | 상태 | `error` | 언제 |
  | --- | --- | --- |
  | 401 | `not_authenticated` | 쿠키 없음 · 세션 만료(7일 동안 요청 없음) · 로그아웃함 · 계정이 삭제됨. 계정이 삭제된 경우 서버가 세션도 지우고 쿠키를 지우는 응답을 보낸다 |
  | 500 | `internal_error` | 서버 오류 |

### POST /api/auth/logout

로그아웃. 세션을 지우고 `sid` 쿠키를 지운다(`Set-Cookie: sid=; Expires=Thu, 01 Jan 1970 …`).

- 요청: 본문 필요 없음(보내도 무시. 단, `Content-Type: application/json`으로 깨진 JSON을 보내면 400 `invalid_json`)
- 성공 **204** (본문 없음)
- 실패

  | 상태 | `error` | 언제 |
  | --- | --- | --- |
  | 401 | `already_logged_out` | 로그인 상태가 아님(쿠키 없음 · 세션 만료 · 계정 삭제). 결과적으로 로그아웃 상태이므로 프론트는 성공처럼 처리해도 된다([7번 열린 질문](#7-프론트와-정해야-할-것)) |
  | 500 | `internal_error` | 서버 오류 |

### POST /api/auth/email/signup

이메일 + 비밀번호로 가입한다. **성공하면 바로 로그인**된다(새 `sid` 발급). 이미 다른 계정으로 로그인한 상태였다면 그 세션은 버리고 새 계정으로 바뀐다.

- 요청: `Content-Type: application/json`

  ```json
  { "email": "me@example.com", "password": "correct horse battery staple", "displayName": "홍길동" }
  ```

  | 필드 | 타입 | 필수 | 규칙 |
  | --- | --- | --- | --- |
  | `email` | string | 예 | 앞뒤 공백 제거 · 소문자로 바꿔 저장. ASCII만. `@` 1개, 로컬 파트 1 ~ 64자, 도메인은 점으로 나뉜 라벨 2개 이상(각 1 ~ 63자, 영문 · 숫자 · 하이픈, 하이픈으로 시작 · 끝 불가). 전체 최대 **254자** |
  | `password` | string | 예 | **8 ~ 128자**. 글자 수는 유니코드 NFC 정규화 후 코드포인트 기준(한글 · 이모지 1자 = 1). 앞뒤 공백도 비밀번호에 포함(지우지 않음). 조합 규칙 없음 |
  | `displayName` | string | 아니요 | 앞뒤 공백 제거. 없거나 비면 `사용자`, 100자를 넘으면 잘림 |

- 성공 **201** + `Set-Cookie: sid=…`

  ```json
  { "id": 3, "displayName": "홍길동", "onboardingStep": "lms_token" }
  ```

- 실패 (검증 에러는 하나만 온다. 순서: 이메일 → 비밀번호 → 이름)

  | 상태 | `error` | `field` | 언제 |
  | --- | --- | --- | --- |
  | 400 | `missing_email` | `email` | 이메일이 없음 · 빈 문자열 · 공백만. 본문이 배열(`[]`)일 때도 |
  | 400 | `invalid_email` | `email` | 문자열이 아님 · 형식이 틀림 · ASCII가 아님 · 로컬 파트 64자 초과 |
  | 400 | `email_too_long` | `email` | 254자 초과 |
  | 400 | `missing_password` | `password` | 비밀번호가 없음 · 빈 문자열 · 문자열이 아님 |
  | 400 | `password_too_short` | `password` | 8자 미만 |
  | 400 | `password_too_long` | `password` | 128자 초과 |
  | 400 | `invalid_display_name` | `displayName` | 문자열이 아님(숫자 등) |
  | 400 | `invalid_json` | — | 본문이 올바른 JSON이 아니거나, 맨 바깥이 객체 · 배열이 아님(`null`, 문자열, 숫자) |
  | 409 | `email_already_registered` | — | 이미 가입된 이메일(대소문자 · 앞뒤 공백만 달라도 같은 이메일). 소셜로 가입한 계정과는 별개라 소셜 계정의 이메일과 같아도 가입된다 |
  | 415 | `unsupported_media_type` | — | `Content-Type`이 `application/json`이 아님 |
  | 500 | `internal_error` | — | 서버 오류 |

  ```json
  { "error": "password_too_short", "field": "password", "message": "비밀번호는 8자 이상이어야 합니다." }
  ```

### POST /api/auth/email/login

이메일 + 비밀번호로 로그인한다. 소셜로 가입한 계정은 이 API로 로그인할 수 없다.

- 요청: `Content-Type: application/json`

  ```json
  { "email": "me@example.com", "password": "correct horse battery staple" }
  ```

  | 필드 | 타입 | 필수 | 규칙 |
  | --- | --- | --- | --- |
  | `email` | string | 예 | 가입과 같은 규칙. 대소문자 · 앞뒤 공백이 달라도 같은 계정 |
  | `password` | string | 예 | 최대 128자(NFC 정규화 후). **최소 길이는 검사하지 않는다**(짧으면 틀린 비밀번호와 같은 401) |

- 성공 **200** + `Set-Cookie: sid=…` (새 세션 ID)

  ```json
  { "id": 3, "displayName": "홍길동", "onboardingStep": "lms_token" }
  ```

- 실패

  | 상태 | `error` | `field` | 언제 |
  | --- | --- | --- | --- |
  | 400 | `missing_email` · `invalid_email` · `email_too_long` | `email` | 가입과 같음 |
  | 400 | `missing_password` · `password_too_long` | `password` | 가입과 같음(`password_too_short`는 없음) |
  | 400 | `invalid_json` | — | 본문이 올바른 JSON이 아님 |
  | 401 | `invalid_credentials` | — | 이메일이 없거나 비밀번호가 틀림(둘을 구분하지 않는다). 메시지: "이메일 또는 비밀번호가 올바르지 않습니다." |
  | 415 | `unsupported_media_type` | — | `Content-Type`이 `application/json`이 아님 |
  | 429 | `too_many_attempts` | — | 같은 이메일 + 같은 IP에서 15분 안에 5번 틀림 → 그때부터 15분 동안. **잠긴 동안은 비밀번호가 맞아도 429.** `Retry-After` 헤더에 남은 초(예: `900`) |
  | 500 | `internal_error` | — | 서버 오류 |

  ```http
  HTTP/1.1 429 Too Many Requests
  Retry-After: 900

  { "error": "too_many_attempts", "message": "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요." }
  ```

- 횟수 · 시간은 서버 설정(`LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`, 기본 5회 · 15분)으로 바뀔 수 있으니, 프론트는 고정값 대신 `Retry-After`를 쓴다.
- 로그인에 성공하면 그 이메일 + IP의 실패 횟수가 지워진다. 없는 이메일로 실패해도 횟수에 들어간다.

### GET /api/auth/kakao

카카오 로그인 시작. **`fetch`가 아니라 브라우저 이동**으로 부른다.

```js
window.location.href = '/api/auth/kakao'
```

- 응답 **302** → 카카오 로그인 · 동의 페이지. 로그인 전 세션 쿠키(`sid`)가 발급된다.
- 이후 흐름은 [3. 소셜 로그인 흐름](#3-소셜-로그인-흐름).

### GET /api/auth/kakao/callback

카카오가 로그인 · 동의 뒤 브라우저를 보내는 주소(카카오 콘솔에 Redirect URI로 등록). **프론트는 직접 부르지 않는다.**

- 쿼리(카카오가 붙임): `code`, `state`, 거부 · 취소 시 `error`
- 응답은 항상 **302**
  - 성공 → `FRONTEND_URL` (새 `sid` 발급)
  - 실패 → `FRONTEND_URL/login/error?error=<코드>` ([소셜 로그인 에러 코드](#소셜-로그인-에러-코드))

### GET /api/auth/google

Google 로그인 시작. 카카오와 같다.

```js
window.location.href = '/api/auth/google'
```

- 응답 **302** → Google 계정 선택 · 동의 페이지(요청 범위: 기본 프로필만, 이메일 요청 안 함). 로그인 전 세션 쿠키가 발급된다.

### GET /api/auth/google/callback

Google이 브라우저를 보내는 주소(Google Cloud 콘솔의 "승인된 리디렉션 URI"). **프론트는 직접 부르지 않는다.**

- 응답은 항상 **302**: 성공 → `FRONTEND_URL`, 실패 → `FRONTEND_URL/login/error?error=<코드>`

### POST /api/lms/token

Canvas 개인 액세스 토큰을 등록한다(이미 있으면 **교체**). 서버가 Canvas에 토큰을 확인한 뒤 **암호화해서** 저장하고, `onboardingStep`을 `done`으로 바꾼 다음, 과목 · 과제 · 공지 **첫 동기화를 백그라운드로** 시작한다. 응답은 동기화가 끝나기 전에 온다.

- 로그인 필요(아니면 401 `not_authenticated`)
- 요청: `Content-Type: application/json`

  ```json
  { "token": "1234~AbCdEf..." }
  ```

  | 필드 | 타입 | 필수 | 규칙 |
  | --- | --- | --- | --- |
  | `token` | string | 예 | 앞뒤 공백 제거 후 1 ~ **200자**, 영문 · 숫자 · `~`만. Canvas → 계정 → 설정 → "새 액세스 토큰"에서 만든 값 |

- 성공 **202**

  ```json
  { "status": "syncing" }
  ```

  - 토큰 원문은 다시 돌려주지 않는다(어떤 API도 토큰 원문 · 일부를 응답하지 않음). 입력칸 값은 등록 후 바로 지운다.
  - 첫 동기화 결과는 [`GET /api/lms/status`](#get-apilmsstatus)로 확인한다(`syncing` → `ok` 또는 `failing` · `needs_reauth`).

- 실패 (아무것도 저장하지 않고 `onboardingStep`도 그대로 `lms_token`)

  | 상태 | `error` | `field` | 언제 |
  | --- | --- | --- | --- |
  | 400 | `missing_token` | `token` | 없음 · 빈 값 · 공백만 · 문자열이 아님 |
  | 400 | `token_too_long` | `token` | 200자 초과 |
  | 400 | `invalid_token_format` | `token` | 영문 · 숫자 · `~` 외의 문자(가운데 공백 · 줄바꿈 포함) |
  | 400 | `canvas_token_rejected` | `token` | Canvas가 토큰을 거부(잘못됨 · 만료 · 취소 · 권한 없음) |
  | 415 | `unsupported_media_type` | — | JSON이 아닌 요청 |
  | 502 | `canvas_unavailable` | — | Canvas에 연결할 수 없음 · Canvas 오류 응답 |
  | 503 | `canvas_rate_limited` | — | Canvas 요청 한도 초과 |
  | 504 | `canvas_timeout` | — | Canvas 응답이 10초 안에 오지 않음 |

### DELETE /api/lms/token

Canvas 연동을 해제한다. 저장된 토큰과 **내** 과목 · 과제 · 공지 연결을 지우고 `onboardingStep`을 `lms_token`으로 되돌린다. 다른 사용자와 함께 쓰는 과목 · 과제 · 공지 자료는 남는다. 해제하면 주기 동기화에서도 빠진다. 해제하는 순간 돌고 있던 동기화는 결과를 반영하지 않는다.

- 로그인 필요 · 본문 없음
- 성공 **204** (본문 없음)
- 실패: 404 `lms_not_connected` (연결된 토큰이 없음)

### GET /api/lms/status

Canvas 연동 · 동기화 상태. 토큰 등록 직후에는 이걸 몇 초 간격으로 불러 첫 동기화가 끝났는지 본다.

- 로그인 필요
- 성공 **200**

  ```json
  { "status": "ok", "connectedAt": "2026-11-13T00:00:00.000Z", "lastSyncedAt": "2026-11-13T00:00:05.120Z", "lastErrorCode": null }
  ```

  연결하지 않았으면 `{ "status": "not_connected" }`만 온다.

  | `status` | 뜻 | 프론트 |
  | --- | --- | --- |
  | `not_connected` | 토큰을 등록하지 않음 | 토큰 입력 화면 |
  | `syncing` | 등록(교체)했고 첫 동기화가 아직 안 끝남 | "불러오는 중" 표시 후 다시 확인 |
  | `ok` | 마지막 동기화 성공 | 정상 |
  | `failing` | 마지막 동기화 실패. 다음 주기(기본 30분)에 다시 시도한다 | `lastErrorCode`에 따라 "Canvas 연결이 잠시 안 됩니다" 등 안내. 그동안 화면은 마지막으로 성공한 자료 |
  | `needs_reauth` | Canvas가 토큰을 거부(만료 · 취소). 주기 동기화에서 빠짐 | 토큰을 다시 등록하라고 안내 |

  | 필드 | 타입 | 설명 |
  | --- | --- | --- |
  | `connectedAt` | string (UTC ISO 8601) | 토큰을 등록(교체)한 시각 |
  | `lastSyncedAt` | string \| null | 마지막으로 동기화를 **반영한** 시각. 첫 동기화 전이면 null |
  | `lastErrorCode` | string \| null | 마지막 실패의 코드(`canvas_unavailable` · `canvas_timeout` · `canvas_rate_limited` · `canvas_forbidden` · `canvas_unauthorized` · `internal_error` 등). 성공하면 null |

### POST /api/lms/sync

지금 동기화를 요청한다. 응답은 바로 오고 동기화는 백그라운드에서 돈다(결과는 상태 API로 확인). 사용자당 **5분에 한 번**.

- 로그인 필요 · 본문 없음
- 성공 **202** `{ "status": "ok" }` (요청 시점의 상태)
- 실패

  | 상태 | `error` | 언제 |
  | --- | --- | --- |
  | 404 | `lms_not_connected` | 연결된 토큰이 없음 |
  | 409 | `lms_needs_reauth` | 토큰을 다시 등록해야 함 |
  | 429 | `sync_too_frequent` | 5분 안에 다시 요청. `Retry-After` 헤더(초) |

### GET /api/calendar/events

기간 안의 **내** 일정 한 목록: Canvas 과제 마감(`source: assignment`) + 앱에서 만든 일정(`source: app`) + 가져온 캘린더 일정(`source: icloud`, 나중에 `google` · `kakao`). 과제 마감은 Canvas가 그 사용자에게 준 값이다(개인 · 분반 연장 반영). 동기화된 자료를 읽기만 한다(Canvas · iCloud를 부르지 않음).

- 로그인 필요
- 요청: 쿼리 `from` · `to` (둘 다 필수)

  ```text
  GET /api/calendar/events?from=2026-11-01T00:00:00%2B09:00&to=2026-12-01T00:00:00%2B09:00
  ```

  | 쿼리 | 규칙 |
  | --- | --- |
  | `from` | **시간대가 붙은** ISO 8601 시각: `YYYY-MM-DDTHH:mm[:ss[.sss]]` + `Z` 또는 `±hh:mm`. 이 시각 **포함** |
  | `to` | 형식은 같음. 이 시각 **미포함**. `from`보다 뒤, `from`부터 최대 **92일** |

  - **시간대가 없는 값(`2026-11-01T00:00:00`) · 날짜만(`2026-11-01`)은 거부한다**(UTC로 간주하지 않음). 브라우저 현지 시각을 그대로 보내면 한국에서는 9시간이 어긋나기 때문. `new Date(...).toISOString()`(Z) 또는 `+09:00`을 붙여 보낸다.
  - 쿼리에서 `+`는 공백으로 읽히므로 `%2B`로 보낸다(`URLSearchParams`가 알아서 바꿔 준다).
  - 오프셋이 붙은 값은 UTC로 바꿔 처리한다.

- 성공 **200**

  ```json
  {
    "from": "2026-10-31T15:00:00.000Z",
    "to": "2026-11-30T15:00:00.000Z",
    "events": [
      {
        "source": "assignment",
        "id": 12,
        "courseName": "자료구조",
        "title": "과제 1",
        "dueAt": "2026-11-20T14:59:00.000Z",
        "url": "https://canvas.example.ac.kr/courses/101/assignments/501"
      }
    ]
  }
  ```

  | 필드 | 타입 | 설명 |
  | --- | --- | --- |
  | `from` · `to` | string | UTC로 바꾼 조회 기간 (`Z`로 끝남) |
  | `events[].source` | string | `assignment`(과제 마감) · `app`(앱 일정) · `icloud`(가져온 일정). 나중에 다른 종류가 붙을 수 있으니 모르는 값은 건너뛴다 |
  | `events[].id` | number | 우리 서버의 과제 id(Canvas id 아님). `source`와 함께 목록 key로 쓴다 |
  | `events[].courseName` | string | 과목 이름 (최대 255자) |
  | `events[].title` | string | 과제 제목 (최대 255자, 없으면 `(제목 없음)`) |
  | `events[].dueAt` | string | 마감 시각, UTC ISO 8601(`Z`). 화면에서 현지 시각으로 바꿔 보여 준다 |
  | `events[].url` | string \| null | Canvas 과제 페이지. 우리 학교 Canvas 주소의 https 링크만 오고, 아니면 null |

  - 위 표는 **과제 항목**(`source: assignment`)의 필드다(기존과 같음). **일정 항목**(`app` · `icloud`)은 `POST /api/calendar/schedules` 응답과 같은 모양이다:

    ```json
    { "source": "icloud", "id": 41, "calendarLinkId": 3, "title": "동아리", "startAt": "2026-11-20T10:00:00.000Z", "endAt": "2026-11-20T11:00:00.000Z", "isAllDay": false, "startDate": null, "endDate": null }
    ```

    - `id`는 일정 id(과제 id와 다른 번호 체계). 목록 key는 `source` + `id`
    - `app`만 수정 · 삭제할 수 있다. `icloud` 등은 읽기 전용(원래 캘린더에서 바꾼다)
    - 시작 = 끝(길이 0)인 일정도 온다(iCloud의 "알림만" 일정 등). 하루 종일이면 `startDate` · `endDate`(끝 미포함)로 달력에 그린다
    - 가져온 일정은 동기화 때 **지난 30일 ~ 앞으로 180일** 범위만 갖고 있다. 그 밖의 기간을 조회하면 가져온 일정은 비어 있다

  - 정렬: 시각(과제는 `dueAt`, 일정은 `startAt`) 오름차순 → 같으면 `assignment` · `app` · `icloud` 순 → `id` 오름차순(항상 같은 순서). 과제만 있을 때는 이전과 같다(마감 → id).
  - 기간: 과제는 `from <= dueAt < to`. 일정은 기간과 겹치면 나온다(`startAt < to` 이고 `endAt > from`, 길이 0 일정은 `from <= startAt < to`). 그래서 기간 앞에서 시작한 일정도 걸쳐 있으면 온다
  - 나오지 않는 것: 마감이 없는 과제, Canvas에서 사라진 과제, 다른 사람의 과제 · 일정, Canvas 연동을 해제했거나 연결하지 않은 사용자의 과제, 지운 앱 일정, 원본에서 사라졌거나 취소된 가져온 일정, 지운 연결의 일정(없으면 빈 목록, 200).

- 실패: 400 (첫 번째 하나만)

  | `error` | `field` | 언제 |
  | --- | --- | --- |
  | `missing_from` · `missing_to` | `from` · `to` | 없음 · 빈 값 |
  | `invalid_from` · `invalid_to` | `from` · `to` | 형식이 틀림 · 시간대 없음 · 없는 날짜(2월 30일) · 같은 쿼리를 두 번 보냄 |
  | `invalid_range` | `to` | `to`가 `from`보다 뒤가 아님 |
  | `range_too_long` | `to` | 92일 초과 |

### POST /api/calendar/schedules

앱에서 직접 만드는 내 일정. (iCloud 등에서 가져온 일정은 원래 캘린더에서 바꾼다.)

- 로그인 필요
- 요청 본문

  ```json
  { "title": "팀 회의", "startAt": "2026-11-20T10:00:00+09:00", "endAt": "2026-11-20T11:30:00+09:00" }
  { "title": "시험 기간", "startAt": "2026-11-20", "endAt": "2026-11-23", "isAllDay": true }
  ```

  | 칸 | 규칙 |
  | --- | --- |
  | `title` | 필수, 앞뒤 공백을 지운 뒤 1 ~ 255자(이모지도 한 글자) |
  | `isAllDay` | 선택, `true` · `false`(기본 `false`) |
  | `startAt` · `endAt` | `isAllDay: false`: **시간대가 붙은** ISO 8601 시각(캘린더 `from` · `to`와 같은 규칙, 시간대 없으면 400). `isAllDay: true`: 날짜 `YYYY-MM-DD`, `endAt`은 **마지막 날 다음 날**(미포함, 하루짜리는 `2026-11-20` ~ `2026-11-21`). 하루 종일은 한국 시간(Asia/Seoul) 자정 기준 |
  | | `startAt` < `endAt` (같으면 400) |

- 성공 **201**: 일정 항목

  ```json
  {
    "source": "app",
    "id": 7,
    "calendarLinkId": null,
    "title": "팀 회의",
    "startAt": "2026-11-20T01:00:00.000Z",
    "endAt": "2026-11-20T02:30:00.000Z",
    "isAllDay": false,
    "startDate": null,
    "endDate": null
  }
  ```

  | 필드 | 타입 | 설명 |
  | --- | --- | --- |
  | `source` | string | `app`(앱 일정) · `icloud`(가져온 일정). 나중에 `google` · `kakao`가 붙을 수 있다 |
  | `id` | number | 일정 id(수정 · 삭제에 씀) |
  | `calendarLinkId` | number \| null | 가져온 일정이면 그 연결 id |
  | `startAt` · `endAt` | string | UTC ISO 8601(`Z`). 하루 종일이면 서울 자정 ~ 다음 자정 |
  | `isAllDay` | boolean | 하루 종일 여부 |
  | `startDate` · `endDate` | string \| null | 하루 종일이면 서울 날짜(`endDate`는 미포함), 아니면 null. 달력에는 이 값을 쓴다 |

- 실패: 400 (첫 번째 하나만, `field` 포함)

  | `error` | `field` | 언제 |
  | --- | --- | --- |
  | `missing_title` · `invalid_title` · `title_too_long` | `title` | 없음 · 공백만 / 글자가 아님 / 255자 초과 |
  | `invalid_is_all_day` | `isAllDay` | `true` · `false`가 아님 |
  | `missing_start_at` · `invalid_start_at` | `startAt` | 없음 / 형식이 틀림(시간대 없음 · 없는 날짜 · 하루 종일인데 시각) |
  | `missing_end_at` · `invalid_end_at` | `endAt` | 위와 같음 |
  | `invalid_range` | `endAt` | 끝이 시작보다 뒤가 아님 |

### PATCH /api/calendar/schedules/:id

내 앱 일정 수정. 보낸 칸만 바꾼다.

- 로그인 필요
- 요청 본문: `title` · `startAt` · `endAt` · `isAllDay` 중 하나 이상(형식은 만들기와 같음). 보낸 시각은 지금 일정의 형식(하루 종일 여부)으로 읽는다. **`isAllDay`를 보내면 `startAt` · `endAt`도 둘 다 새 형식으로 보낸다**(형식이 바뀌므로, 없으면 `missing_start_at` · `missing_end_at`)
- 검사는 **보낸 칸과 지금 값을 합친 결과**로 한다: `startAt`만 바꿔 지금 `endAt`보다 늦어지거나, `endAt`만 바꿔 지금 `startAt`보다 빨라지면 400 `invalid_range`
- 성공 **200**: 바뀐 일정 항목(만들기 응답과 같은 모양)
- 실패
  - 400: 만들기와 같은 코드 + `empty_update`(바꿀 칸 없음). 바꾼 결과가 시작 >= 끝이면 `invalid_range`, 일정은 그대로
  - **403** `schedule_read_only`: iCloud 등 가져온 일정
  - **404** `schedule_not_found`: 없는 일정 · **다른 사람의 일정** · 지운 일정 · 숫자가 아닌 id

### DELETE /api/calendar/schedules/:id

내 앱 일정 삭제.

- 로그인 필요
- 성공 **204** (본문 없음)
- 실패: **403** `schedule_read_only`(가져온 일정), **404** `schedule_not_found`(없음 · 다른 사람 · 이미 지움)

### POST /api/calendar/links/icloud

iPhone · Mac 캘린더의 **공개 캘린더 링크**를 등록해 그 캘린더의 일정을 가져온다(읽기 전용). 캘린더마다 링크가 따로라 여러 개 등록할 수 있다(최대 5개).

- 로그인 필요
- 요청 본문: `{ "url": "webcal://p52-caldav.icloud.com/published/2/…" }`
  - `webcal://` · `https://` 모두 받는다(서버가 https로 바꿔 요청). **http는 거부**
  - **iCloud 링크만**: 호스트가 `icloud.com`이거나 `….icloud.com`. 계정 정보(`user@`) · 다른 포트 · IP 주소는 거부
  - 최대 1024자. 쿼리(`?…`) · 조각(`#…`)은 버린다
- 순서: 형식 검사 → 이미 등록했는지 · 개수 확인 → **실제로 받아 캘린더로 읽히는지 확인** → 저장 → 첫 동기화(백그라운드). 실패하면 아무것도 저장하지 않는다
- 성공 **202**: `{ "id": 3, "provider": "icloud", "syncStatus": "syncing" }`. 일정은 첫 동기화가 끝나면 `GET /api/calendar/events`에 나온다(`GET /api/calendar/links`의 `syncStatus`가 `ok`가 되면 끝)
- **링크는 비밀번호와 같다**(가진 사람은 누구나 일정을 볼 수 있음). 서버는 암호화해 저장하고 응답 · 목록 어디에도 돌려주지 않는다. 화면에도 다시 보여 주지 말 것
- 실패 (`field: url`)

  | 상태 | `error` | 언제 |
  | --- | --- | --- |
  | 400 | `missing_url` · `url_too_long` · `invalid_url` | 없음 · 1024자 초과 · URL 형식이 아님 |
  | 400 | `insecure_url` | http 링크 |
  | 400 | `host_not_allowed` | iCloud가 아닌 주소 · 계정 정보 · 다른 포트 · IP |
  | 400 | `icloud_link_invalid` | iCloud가 링크를 찾지 못함(공개 해제 · 잘못 복사) |
  | 400 | `icloud_not_calendar` · `icloud_parse_failed` | 캘린더가 아니거나 읽을 수 없음 |
  | 400 | `icloud_redirect_rejected` · `icloud_too_many_redirects` | iCloud 밖으로 이동 · 이동이 너무 많음 |
  | 400 | `icloud_too_large` · `icloud_too_many_events` | 5MB 초과 · 가까운 기간(지난 30일 ~ 앞으로 180일) 일정이 5000개 초과 |
  | 409 | `calendar_link_already_registered` | 이미 등록한 링크(webcal · https · 대소문자 차이는 같은 링크) |
  | 409 | `calendar_link_limit_reached` | 이미 5개 |
  | 502 · 503 · 504 | `icloud_unavailable` · `icloud_rate_limited` · `icloud_timeout` | iCloud 연결 실패 · 요청 한도 · 응답 지연("잠시 후 다시") |

### GET /api/calendar/links

내 외부 캘린더 연결 목록.

- 로그인 필요
- 성공 **200**

  ```json
  {
    "links": [
      { "id": 3, "provider": "icloud", "syncStatus": "ok", "lastSyncedAt": "2026-11-14T03:00:00.000Z", "lastErrorCode": null, "createdAt": "2026-11-14T02:59:58.000Z" }
    ]
  }
  ```

  | 필드 | 설명 |
  | --- | --- |
  | `syncStatus` | `syncing`(첫 동기화 전) · `ok` · `failing`(다음 주기에 다시 시도) · `invalid`(링크를 더 쓸 수 없음 → 지우고 새 링크로 다시 등록하라고 안내) |
  | `lastErrorCode` | 마지막 실패 코드(위 등록 실패 표의 `icloud_*`, 또는 `internal_error`), 성공하면 null |

  - **링크(URL) 칸은 없다.** 화면에서 연결을 구분하려면 `id` · `createdAt`을 쓴다

### DELETE /api/calendar/links/:id

연결을 지운다. 그 연결에서 가져온 일정도 함께 지워진다(iCloud 캘린더 자체는 그대로).

- 로그인 필요
- 성공 **204**. 실패 **404** `calendar_link_not_found`(없음 · 다른 사람의 연결)

### POST /api/calendar/links/:id/sync

지금 동기화. 실제로는 내 연결 전체를 동기화한다(백그라운드).

- 로그인 필요
- 성공 **202** `{ "syncStatus": "ok" }`(요청 시점 상태). 끝났는지는 `GET /api/calendar/links`로
- 실패: **404** `calendar_link_not_found`, **409** `calendar_link_invalid`(`invalid` 상태), **429** `sync_too_frequent` + `Retry-After`(초) — 연결별 5분에 한 번

### GET /api/notifications

동기화 때 감지한 **내** Canvas 변경 알림(앱 안 알림함). 푸시 · 메일은 보내지 않는다. 동기화된 자료를 읽기만 한다.

- 로그인 필요
- 요청: 쿼리 모두 선택

  ```text
  GET /api/notifications?unread=true&limit=20
  GET /api/notifications?limit=20&cursor=MzA
  ```

  | 쿼리 | 규칙 |
  | --- | --- |
  | `unread` | `true`(안 읽은 것만) 또는 `false`(전부, 기본) |
  | `limit` | 1 ~ 50 정수, 기본 20 |
  | `cursor` | 앞 페이지 응답의 `nextCursor`를 **그대로**. 직접 만들지 말 것(불투명 값). 다음 페이지도 같은 `unread` · `limit`으로 부른다 |

- 성공 **200**

  ```json
  {
    "notifications": [
      {
        "id": 31,
        "kind": "assignment_due_changed",
        "courseName": "자료구조",
        "title": "과제 1",
        "before": { "dueAt": "2026-11-20T14:59:00.000Z" },
        "after": { "dueAt": "2026-11-27T14:59:00.000Z" },
        "detectedAt": "2026-11-13T03:00:00.000Z",
        "read": false,
        "url": "https://canvas.example.ac.kr/courses/101/assignments/501"
      }
    ],
    "nextCursor": "MzA"
  }
  ```

  | 필드 | 타입 | 설명 |
  | --- | --- | --- |
  | `notifications[].id` | number | 알림 id. 읽음 처리에 쓴다 |
  | `notifications[].kind` | string | 아래 표. 나중에 종류가 늘 수 있으니 모르는 값은 건너뛴다 |
  | `notifications[].courseName` | string | 과목 이름 |
  | `notifications[].title` | string | 과제 · 공지의 지금 제목 |
  | `notifications[].before` · `after` | object \| null | 바뀌기 전 · 후 값(아래 표). 마감은 UTC ISO 8601(`Z`), `dueAt: null`은 "마감 없음" |
  | `notifications[].detectedAt` | string | 감지 시각(UTC). 같은 변경이 읽기 전에 또 바뀌면 한 알림으로 합쳐지고 이 시각만 새로 바뀐다 |
  | `notifications[].read` | boolean | 읽음 여부 |
  | `notifications[].url` | string \| null | Canvas 과제 · 공지 페이지(우리 학교 Canvas의 https 링크만, 아니면 null) |
  | `nextCursor` | string \| null | 다음 페이지가 있으면 값, 마지막 페이지면 null |

  | `kind` | 뜻 | `before` | `after` |
  | --- | --- | --- | --- |
  | `assignment_created` | 새 과제 | null | `{ dueAt }` |
  | `assignment_due_changed` | 마감 변경(생김 · 없어짐 포함) | `{ dueAt }` | `{ dueAt }` |
  | `assignment_title_changed` | 과제 제목 변경 | `{ title }` | `{ title }` |
  | `assignment_removed` | 과제가 Canvas에서 사라짐 | `{ dueAt }` | null |
  | `announcement_created` | 새 공지 | null | null |
  | `announcement_updated` | 공지 수정(본문만 바뀌면 제목 전 = 후) | `{ title }` | `{ title }` |

  - 정렬: 최신순(`id` 내림차순). 합쳐진 알림은 처음 자리에 남는다.
  - **공지 본문은 오지 않는다.** 공지 내용은 `url`로 Canvas에서 본다.
  - 알리지 않는 것: Canvas 연동 직후 첫 동기화 · 다른 Canvas 계정으로 바꾼 직후 · 새로 수강한 과목의 기존 과제 · 공지, 마감이 이미 지난 과제의 변경, 수강이 끝난 과목의 과제.
  - Canvas 연동을 해제하거나 다른 Canvas 계정 토큰으로 바꾸면 그때까지의 알림은 지워진다.

- 실패: 400

  | `error` | 언제 |
  | --- | --- |
  | `invalid_cursor` | `cursor`가 받은 값이 아님(형식 틀림 · 두 번 보냄 등) |
  | `invalid_limit` | 1 ~ 50 정수가 아님 |
  | `invalid_unread` | `true` · `false`가 아님 |

### POST /api/notifications/read-all

내 알림을 전부 읽음으로. 본문 없음.

- 로그인 필요
- 성공 **204** (본문 없음). 읽을 알림이 없어도 204

### POST /api/notifications/:id/read

알림 하나를 읽음으로. 본문 없음.

- 로그인 필요
- 성공 **204** (본문 없음). 이미 읽은 알림도 204(읽은 시각은 처음 값 그대로)
- 실패: **404** `notification_not_found` — 없는 id, **다른 사람의 알림**, 숫자가 아닌 id 모두 같은 응답

### GET /api/calendar/conflicts

기간 안에서 **시간이 겹치는 내 일정 쌍**. 앱 일정 · 가져온 일정끼리(과제 마감은 포함하지 않음).

- 로그인 필요
- 요청: 쿼리 `from` · `to` — `GET /api/calendar/events`와 **같은 규칙**(시간대 필수, `[from, to)`, 최대 92일, 같은 오류 코드)
- 성공 **200**

  ```json
  {
    "from": "2026-11-01T00:00:00.000Z",
    "to": "2026-12-01T00:00:00.000Z",
    "conflicts": [
      {
        "kind": "schedule_overlap",
        "a": { "source": "app", "id": 7, "title": "회의", "startAt": "2026-11-20T01:00:00.000Z", "endAt": "2026-11-20T02:00:00.000Z" },
        "b": { "source": "icloud", "id": 41, "title": "동아리", "startAt": "2026-11-20T01:30:00.000Z", "endAt": "2026-11-20T02:30:00.000Z" },
        "overlapStartAt": "2026-11-20T01:30:00.000Z",
        "overlapEndAt": "2026-11-20T02:00:00.000Z"
      }
    ],
    "truncated": false
  }
  ```

  | 필드 | 설명 |
  | --- | --- |
  | `conflicts[].kind` | 지금은 `schedule_overlap`(일정끼리)만. 모르는 값은 건너뛴다 |
  | `conflicts[].a` · `b` | 겹치는 두 일정. `a`가 먼저 시작한 쪽(같으면 id 작은 쪽). 같은 쌍은 한 번만(`(A, B)`와 `(B, A)`는 하나) |
  | `conflicts[].overlapStartAt` · `overlapEndAt` | 겹친 구간(UTC) |
  | `truncated` | 겹친 쌍이 **500개**를 넘어 앞에서부터 500개만 왔으면 true. 화면에 "더 있음"을 표시하고 기간을 줄여 다시 조회 |

  - 겹침 = `A.start < B.end` 이고 `B.start < A.end`. **끝과 시작이 맞닿으면 겹침이 아니다**(10:00 ~ 11:00과 11:00 ~ 12:00)
  - 빼는 것: **하루 종일 일정**(휴일 · 시험 기간처럼 그날 모든 일정과 겹쳐 쓸모없어서), **길이 0 일정**, 지운 · 취소된 일정, 다른 사람의 일정
  - 반복 일정은 회차마다 따로 본다(겹치는 회차만 나온다)
  - 정렬: `a.startAt` → `a.id` → `b.startAt` → `b.id` (항상 같은 순서)
  - 알려진 한계: 같은 일정이 여러 iCloud 캘린더에 함께 들어 있으면 서로 겹침으로 나온다

### Canvas 자료를 화면에 보여 줄 때 (보안)

- 과목 이름 · 과제 제목 · 알림의 제목(`title` · `before.title` · `after.title`) · 가져온 일정 제목 · (나중에 생길) 공지 본문은 **Canvas · iCloud에서 온 그대로**다. 교수 · 조교 등 다른 사람이 쓴 글이므로 **`innerHTML`(React의 `dangerouslySetInnerHTML`, Vue의 `v-html`)로 넣지 말 것.** 글자로만 넣는다(`textContent`, React · Vue 기본 바인딩).
- 공지 본문은 서버에 **Canvas HTML 원본 그대로** 저장되어 있다(정제하지 않음). 공지 API가 생겨 HTML로 보여 줘야 할 때는 반드시 DOMPurify 같은 정제 도구를 거친 뒤에 넣는다.
- `url`은 서버가 우리 학교 Canvas 주소의 https 링크인지 확인한 값이지만, 새 창으로 열 때는 `rel="noopener noreferrer"`를 붙인다.

## 3. 소셜 로그인 흐름

```text
[프론트] 버튼 클릭
   └─ window.location.href = '/api/auth/kakao'  (또는 /api/auth/google)
[백엔드] 302 → 카카오 / Google 로그인 · 동의 화면
[사용자] 로그인 · 동의 (또는 취소)
[카카오 / Google] 302 → /api/auth/{kakao|google}/callback?code=…&state=…
[백엔드] 확인 → 계정 조회 또는 생성 → 세션 발급
   ├─ 성공: 302 → FRONTEND_URL
   └─ 실패: 302 → FRONTEND_URL/login/error?error=<코드>
[프론트] FRONTEND_URL 화면에서 GET /api/auth/me 로 사용자 확인
```

- 프론트가 할 일은 **버튼에서 이동시키는 것과, 돌아온 뒤 `/api/auth/me`를 부르는 것**뿐이다. 코드 · 토큰을 다룰 필요가 없다.
- 첫 로그인이면 그 자리에서 계정이 만들어진다(별도 가입 단계 없음). 카카오 · Google · 이메일은 같은 사람이라도 **별개 계정**이다(계정 연결 기능 없음).
- 성공 후 이동 주소는 지금은 항상 `FRONTEND_URL`(루트)이다. 화면 분기는 `/api/auth/me`의 `onboardingStep`으로 한다.

### 소셜 로그인 에러 코드

실패하면 `FRONTEND_URL/login/error?error=<코드>`로 온다. 쿼리에는 `error` 하나만 있고 상세 내용은 없다(원인은 서버 로그에 남는다).

| `error` | 언제 | 사용자에게 보여 줄 메시지 예시 |
| --- | --- | --- |
| `invalid_state` | 로그인 요청이 만료 · 위조 · 재사용됨(뒤로 가기 후 다시 제출, 로그인 화면을 오래 열어 둠, 다른 제공자로 시작한 요청 등) | 로그인 요청이 만료되었습니다. 다시 시도해 주세요. |
| `invalid_request` | 제공자 응답에 인가 코드가 없음 | 로그인 응답이 올바르지 않습니다. 다시 시도해 주세요. |
| `kakao_login_denied` | 카카오 동의 화면에서 취소 · 거부 | 카카오 로그인을 취소했습니다. |
| `kakao_api_failed` | 카카오 서버와 통신 실패 · 응답 이상 | 카카오 로그인 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요. |
| `google_login_denied` | Google 동의 화면에서 취소 · 거부 | Google 로그인을 취소했습니다. |
| `google_api_failed` | Google 서버와 통신 실패 · 응답(id_token) 이상 | Google 로그인 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요. |
| `server_error` | 그 밖의 서버 오류 | 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요. |

모든 경우 "다시 로그인" 버튼으로 로그인 화면에 돌아가게 하면 된다. 같은 로그인 요청은 재사용할 수 없으므로 버튼은 다시 `/api/auth/kakao`(또는 google)로 이동시킨다.

## 4. onboarding_step 사용법

`GET /api/auth/me`의 `onboardingStep`으로 다음 화면을 정한다.

| 값 | 의미 | 프론트 |
| --- | --- | --- |
| `lms_token` | 가입 직후. LMS(Canvas) 토큰을 아직 등록하지 않음 | LMS 토큰 입력 화면을 띄운다 |
| `done` | 온보딩 끝 | 홈으로 |

```js
const res = await fetch('/api/auth/me')
if (res.status === 401) return navigate('/login')
const { onboardingStep } = await res.json()
navigate(onboardingStep === 'lms_token' ? '/onboarding/lms-token' : '/')
```

- 가입(소셜 첫 로그인 · 이메일 가입) 직후는 항상 `lms_token`.
- Canvas 토큰 등록(`POST /api/lms/token`)이 성공하면 `done`으로 바뀐다. 등록이 실패하면 그대로 `lms_token`.
- 값은 앞으로 늘어날 수 있으니, 모르는 값이 오면 홈으로 보내는 등 기본 처리를 둔다.

## 5. 에러 코드 전체 표

| `error` | 상태 | 어디서 | 의미 | 프론트에서 할 일 |
| --- | --- | --- | --- | --- |
| `not_authenticated` | 401 | `GET /me`, `/api/lms/*` · `/api/calendar/*`(일정 포함) · `/api/notifications/*` | 로그인 안 됨 · 세션 만료 · 계정 삭제 | 로그인 화면으로 |
| `already_logged_out` | 401 | `POST /logout` | 이미 로그아웃 상태 | 로그아웃 성공처럼 처리(로그인 화면으로) |
| `missing_email` | 400 | 이메일 가입 · 로그인 | 이메일 없음 | `field: email` 입력칸에 `message` 표시 |
| `invalid_email` | 400 | 이메일 가입 · 로그인 | 이메일 형식 틀림 | 위와 같음 |
| `email_too_long` | 400 | 이메일 가입 · 로그인 | 254자 초과 | 위와 같음 |
| `missing_password` | 400 | 이메일 가입 · 로그인 | 비밀번호 없음 | `field: password` 입력칸에 표시 |
| `password_too_short` | 400 | 이메일 가입 | 8자 미만 | 위와 같음 |
| `password_too_long` | 400 | 이메일 가입 · 로그인 | 128자 초과 | 위와 같음 |
| `invalid_display_name` | 400 | 이메일 가입 | 이름이 문자열이 아님 | `field: displayName` 입력칸에 표시(보통 프론트 버그) |
| `invalid_json` | 400 | JSON 본문을 받는 API | 본문이 올바른 JSON이 아님 | 프론트 버그. `JSON.stringify`로 보내는지 확인 |
| `invalid_credentials` | 401 | 이메일 로그인 | 이메일 없음 또는 비밀번호 틀림 | `message` 표시(어느 쪽이 틀렸는지 구분하지 말 것) |
| `email_already_registered` | 409 | 이메일 가입 | 이미 가입된 이메일 | "이미 가입된 이메일입니다" + 로그인 화면 안내 |
| `unsupported_media_type` | 415 | 이메일 가입 · 로그인, Canvas 토큰 등록 | JSON이 아닌 요청 | 프론트 버그. `Content-Type: application/json` 확인 |
| `missing_token` | 400 | Canvas 토큰 등록 | 토큰 없음 | `field: token` 입력칸에 `message` 표시 |
| `token_too_long` | 400 | Canvas 토큰 등록 | 200자 초과 | 위와 같음 |
| `invalid_token_format` | 400 | Canvas 토큰 등록 | 허용하지 않는 문자 | 위와 같음(복사할 때 딸려 온 공백 · 따옴표 확인 안내) |
| `canvas_token_rejected` | 400 | Canvas 토큰 등록 | Canvas가 토큰을 거부 | 입력칸에 표시 + 새 토큰을 만들어 다시 넣으라고 안내 |
| `canvas_unavailable` | 502 | Canvas 토큰 등록 | Canvas 연결 실패 · 오류 | "잠시 후 다시 시도" 표시 |
| `lms_not_connected` | 404 | Canvas 연동 해제 · 수동 동기화 | 연결된 토큰 없음 | 토큰 입력 화면으로 |
| `missing_from` · `missing_to` | 400 | 캘린더 · 겹침 | 기간 쿼리 없음 | 프론트 버그. 두 쿼리를 모두 보낸다 |
| `invalid_from` · `invalid_to` | 400 | 캘린더 · 겹침 | 형식 틀림 · 시간대 없음 · 없는 날짜 | 프론트 버그. `toISOString()` 또는 `+09:00`을 붙여 보낸다 |
| `invalid_range` | 400 | 캘린더 · 겹침 · 앱 일정 | 캘린더 · 겹침: `to`가 `from` 이후가 아님 / 앱 일정: 끝이 시작 이후가 아님 | 캘린더는 프론트 버그, 앱 일정은 `field: endAt` 입력칸에 표시 |
| `range_too_long` | 400 | 캘린더 · 겹침 | 92일 초과 | 달력 보기 단위(월 · 주)로 나눠 부른다 |
| `missing_title` · `invalid_title` · `title_too_long` | 400 | 앱 일정 만들기 · 수정 | 제목 없음 · 글자 아님 · 255자 초과 | `field: title` 입력칸에 `message` 표시 |
| `missing_start_at` · `invalid_start_at` · `missing_end_at` · `invalid_end_at` | 400 | 앱 일정 만들기 · 수정 | 시각 없음 · 형식 틀림 | 입력칸에 표시. 시각은 `+09:00` · `Z`, 하루 종일은 날짜만 |
| `invalid_is_all_day` | 400 | 앱 일정 만들기 · 수정 | `isAllDay`가 불리언이 아님 | 프론트 버그 |
| `empty_update` | 400 | 앱 일정 수정 | 바꿀 칸 없음 | 프론트 버그 |
| `missing_url` · `url_too_long` · `invalid_url` · `insecure_url` · `host_not_allowed` | 400 | iCloud 연결 등록 | 링크 형식 · 주소 문제 | `field: url` 입력칸에 `message` 표시 |
| `icloud_link_invalid` · `icloud_not_calendar` · `icloud_parse_failed` · `icloud_redirect_rejected` · `icloud_too_many_redirects` · `icloud_too_large` · `icloud_too_many_events` | 400 | iCloud 연결 등록 | 받아 보니 쓸 수 없는 링크 | 입력칸에 `message` 표시 |
| `icloud_unavailable` · `icloud_rate_limited` · `icloud_timeout` | 502 · 503 · 504 | iCloud 연결 등록 | iCloud 쪽 문제 | "잠시 후 다시 시도" |
| `calendar_link_already_registered` · `calendar_link_limit_reached` | 409 | iCloud 연결 등록 | 이미 등록 · 5개 초과 | `message` 표시 |
| `calendar_link_not_found` | 404 | 연결 삭제 · 수동 동기화 | 없음 · 다른 사람 | 목록을 새로 불러온다 |
| `calendar_link_invalid` | 409 | 수동 동기화 | 링크를 더 쓸 수 없음 | 연결을 지우고 다시 등록하라고 안내 |
| `schedule_read_only` | 403 | 앱 일정 수정 · 삭제 | 가져온 캘린더의 일정 | 수정 · 삭제 버튼을 숨긴다(`source !== 'app'`) |
| `schedule_not_found` | 404 | 앱 일정 수정 · 삭제 | 없음 · 다른 사람 · 지움 | 목록을 새로 불러온다 |
| `invalid_cursor` | 400 | 알림 목록 | 커서가 받은 값이 아님 | 프론트 버그. `nextCursor`를 그대로 보낸다(없으면 첫 페이지부터) |
| `invalid_limit` | 400 | 알림 목록 | `limit`이 1 ~ 50 정수가 아님 | 프론트 버그 |
| `invalid_unread` | 400 | 알림 목록 | `unread`가 `true` · `false`가 아님 | 프론트 버그 |
| `notification_not_found` | 404 | 알림 읽음 | 없는 알림 · 다른 사람의 알림 | 목록을 새로 불러온다 |
| `lms_needs_reauth` | 409 | 수동 동기화 | 토큰 만료 · 취소 | 토큰을 다시 등록하라고 안내 |
| `sync_too_frequent` | 429 | Canvas · 캘린더 수동 동기화 | 5분 안에 다시 요청 | `Retry-After`(초)만큼 동기화 버튼 비활성화 |
| `canvas_rate_limited` | 503 | Canvas 토큰 등록 | Canvas 요청 한도 초과 | 위와 같음 |
| `canvas_timeout` | 504 | Canvas 토큰 등록 | Canvas 응답 지연 | 위와 같음 |
| `unsupported_charset` | 415 | JSON 본문을 받는 API | 문자셋이 UTF-8이 아님 | 프론트 버그. `charset`을 빼거나 `utf-8`로 |
| `unsupported_encoding` | 415 | JSON 본문을 받는 API | 지원하지 않는 `Content-Encoding` | 프론트 버그. 압축 헤더를 직접 붙이지 말 것 |
| `payload_too_large` | 413 | 본문을 받는 API | 본문 100KB 초과 | 프론트 버그(정상 요청은 닿지 않음) |
| `too_many_attempts` | 429 | 이메일 로그인 | 실패 횟수 초과로 잠김 | `Retry-After`(초)를 분으로 바꿔 "N분 뒤 다시 시도" 표시, 그동안 로그인 버튼 비활성화 |
| `not_found` | 404 | `/api` 전체 | 없는 경로 · 잘못된 메서드 | 프론트 버그. 경로 · 메서드 확인 |
| `internal_error` | 500 | 모든 JSON API | 서버 오류 | "잠시 후 다시 시도" 표시. `requestId`를 신고용으로 보여 줘도 됨 |
| `invalid_state` | (302 쿼리) | 소셜 콜백 | 로그인 요청 만료 · 위조 · 재사용 | 에러 화면 + 다시 로그인 |
| `invalid_request` | (302 쿼리) | 소셜 콜백 | 인가 코드 없음 | 에러 화면 + 다시 로그인 |
| `kakao_login_denied` | (302 쿼리) | 카카오 콜백 | 사용자가 취소 | 에러 화면 대신 로그인 화면으로 바로 돌려보내도 됨 |
| `kakao_api_failed` | (302 쿼리) | 카카오 콜백 | 카카오 통신 실패 | 에러 화면 + 다시 로그인 |
| `google_login_denied` | (302 쿼리) | Google 콜백 | 사용자가 취소 | 로그인 화면으로 |
| `google_api_failed` | (302 쿼리) | Google 콜백 | Google 통신 실패 · 응답 이상 | 에러 화면 + 다시 로그인 |
| `server_error` | (302 쿼리) | 소셜 콜백 | 그 밖의 서버 오류 | 에러 화면 + 다시 로그인 |

## 6. 알려진 동작

지금 코드의 동작이다. 바뀌면 이 문서도 고친다.

- 로그인 실패 횟수 기록은 서버 메모리에 있어 서버를 재시작하면 초기화된다.
- 수동 동기화 5분 제한 기록도 서버 메모리에 있어 재시작하면 초기화된다.
- Canvas 주기 동기화는 서버가 시작하고 한 주기(기본 30분) 뒤에 처음 돈다. 동시에 도는 동기화 수에 상한(기본 2)이 있어, 요청이 몰리면 상태가 잠깐 `syncing` 또는 이전 값으로 남을 수 있다.

## 7. 프론트와 정해야 할 것

1. **소셜 로그인 에러 화면 경로**: 지금은 `FRONTEND_URL/login/error?error=<코드>`. 경로(`/login/error`)와 쿼리 이름(`error`)을 이대로 갈지.
2. **로그인 성공 후 이동 경로**: 지금은 항상 `FRONTEND_URL` 루트. `onboardingStep`에 따라 백엔드가 바로 토큰 입력 화면(예: `/onboarding/lms-token`)으로 보낼지, 프론트가 `/me`를 보고 분기할지.
3. **이미 로그아웃된 상태에서 로그아웃**: 지금은 401 `already_logged_out`. 결과가 같으니(로그아웃 상태) 204로 바꿀지.
