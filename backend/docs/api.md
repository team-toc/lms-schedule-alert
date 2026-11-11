# 백엔드 API 설명서

프론트엔드 연동용. 실제 코드(`src/app.js`, `src/auth/*`, `src/email/email-input.js`) 기준으로 쓴다. 라우트를 추가 · 변경하는 커밋에서 이 문서도 같이 고친다(`test/api-doc.test.js`가 문서에 없는 라우트를 잡는다).

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
| 200 | 성공(본문 있음) | `/me`, 이메일 로그인, health |
| 201 | 이메일 가입 성공 | 이메일 가입 |
| 204 | 로그아웃 성공(본문 없음) | 로그아웃 |
| 302 | 리다이렉트 | 소셜 로그인 시작 · 콜백 |
| 400 `invalid_json` | `Content-Type: application/json`인데 본문이 올바른 JSON이 아니거나, 맨 바깥이 객체 · 배열이 아님(`null` 등) | JSON 본문을 받는 모든 API |
| 400 (검증) | 입력 검증 실패. `field`로 어느 항목인지 알려 준다 | 이메일 가입 · 로그인 |
| 401 | 로그인 안 됨 / 이미 로그아웃됨 / 이메일 · 비밀번호 틀림 (API마다 `error`가 다름) | `/me`, 로그아웃, 이메일 로그인 |
| 404 `not_found` | `/api` 아래 없는 경로, 또는 있는 경로에 잘못된 메서드(예: `GET /api/auth/logout`). 405로 나누지 않는다 | `/api` 전체 |
| 409 | 이미 가입된 이메일 | 이메일 가입 |
| 413 `payload_too_large` | 본문이 100KB를 넘음 | 본문을 받는 모든 API |
| 415 `unsupported_media_type` | JSON이 아닌 요청 | 이메일 가입 · 로그인만 |
| 415 `unsupported_charset` · `unsupported_encoding` | JSON 본문의 문자셋이 UTF-8이 아님 · 지원하지 않는 `Content-Encoding` | JSON 본문을 받는 모든 API |
| 429 | 로그인 실패 횟수 초과. `Retry-After` 헤더(초) | 이메일 로그인만 |
| 500 | 서버 오류. `requestId` 포함 | 모든 JSON API |

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
- LMS 토큰 등록 API는 아직 없다. 생기면 등록 성공 시 `done`으로 바뀐다(이 문서에 추가 예정).
- 값은 앞으로 늘어날 수 있으니, 모르는 값이 오면 홈으로 보내는 등 기본 처리를 둔다.

## 5. 에러 코드 전체 표

| `error` | 상태 | 어디서 | 의미 | 프론트에서 할 일 |
| --- | --- | --- | --- | --- |
| `not_authenticated` | 401 | `GET /me` | 로그인 안 됨 · 세션 만료 · 계정 삭제 | 로그인 화면으로 |
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
| `unsupported_media_type` | 415 | 이메일 가입 · 로그인 | JSON이 아닌 요청 | 프론트 버그. `Content-Type: application/json` 확인 |
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

## 7. 프론트와 정해야 할 것

1. **소셜 로그인 에러 화면 경로**: 지금은 `FRONTEND_URL/login/error?error=<코드>`. 경로(`/login/error`)와 쿼리 이름(`error`)을 이대로 갈지.
2. **로그인 성공 후 이동 경로**: 지금은 항상 `FRONTEND_URL` 루트. `onboardingStep`에 따라 백엔드가 바로 토큰 입력 화면(예: `/onboarding/lms-token`)으로 보낼지, 프론트가 `/me`를 보고 분기할지.
3. **이미 로그아웃된 상태에서 로그아웃**: 지금은 401 `already_logged_out`. 결과가 같으니(로그아웃 상태) 204로 바꿀지.
