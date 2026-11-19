# 브라우저 푸시(Web Push) 연동 — 프론트용

백엔드가 Canvas 변경 알림(마감 변경 · 새 공지 등)을 **브라우저 푸시**로도 보낸다. 앱 안 알림 목록(`GET /api/notifications`)은 그대로이고, 푸시는 "앱을 안 열어도 알려 주는" 추가 통로다.
프론트가 할 일은 세 가지다: **서비스 워커**(받은 푸시를 알림으로 띄우기), **구독 등록**(이 브라우저를 계정에 연결), **로그아웃 때 해제**.

API 세부(요청 · 응답 · 에러 코드)는 [api.md](api.md)의 `/api/push/*` 절과 같다. 백엔드 설계 근거는 ADR 0012(백엔드 로컬 문서).

- [1. 준비물 · 지원 환경](#1-준비물--지원-환경)
- [2. 서비스 워커 예시 (sw.js)](#2-서비스-워커-예시-swjs)
- [3. 구독 흐름 (앱 코드)](#3-구독-흐름-앱-코드)
- [4. 로그아웃 순서](#4-로그아웃-순서)
- [5. 아이폰 · 아이패드 체크리스트](#5-아이폰--아이패드-체크리스트)
- [6. 배포 참고 (서버 담당)](#6-배포-참고-서버-담당)
- [7. 오류 처리](#7-오류-처리)
- [8. 받는 내용 (payload)](#8-받는-내용-payload)
- [9. 개발 중 확인하기](#9-개발-중-확인하기)
- [10. 열린 질문 · 확인 필요](#10-열린-질문--확인-필요)

## 1. 준비물 · 지원 환경

- **HTTPS 필요**(서비스 워커 · 푸시는 보안 출처에서만). 개발은 `http://localhost`가 예외로 된다
- 서비스 워커 파일 `sw.js`를 **사이트 루트**(`/sw.js`)에서 제공(6절)
- 지원: Chrome · Edge · Firefox(데스크톱 · 안드로이드), Safari(macOS 13 Ventura 이상), iPhone · iPad는 **iOS · iPadOS 16.4 이상의 "홈 화면에 추가"한 웹앱에서만**(5절)
- 백엔드가 받는 구독 주소는 알려진 푸시 서비스(Chrome · Edge · Firefox · Safari)뿐이다. 그 밖의 브라우저 구독은 400 `push_service_not_allowed`(7절)

## 2. 서비스 워커 예시 (sw.js)

아래는 **예시**다. 프로젝트 구조에 맞게 옮긴다(Vite라면 `public/sw.js`에 두면 빌드 결과의 루트 `/sw.js`로 그대로 나간다).

```js
// sw.js — 브라우저 푸시 받기 · 알림 클릭 · 구독 갱신
const PAYLOAD_VERSION = 1
const FALLBACK = { title: '새 알림', body: '앱에서 확인하세요', url: '/' }

// 1) 푸시를 받으면 반드시 알림을 띄운다(userVisibleOnly: true 약속, 안 띄우면 브라우저가 경고 · 구독 취소할 수 있음)
self.addEventListener('push', (event) => {
  let data = null
  try {
    data = event.data ? event.data.json() : null
  } catch {
    data = null
  }
  // 버전이 다르거나 모양이 틀리면 내용 없이 기본 알림(모르는 형식을 그대로 보여 주지 않음)
  const ok = data && data.v === PAYLOAD_VERSION && typeof data.title === 'string'
  const shown = ok ? data : FALLBACK
  // tag: 같은 알림(notificationId)이 "합치기"로 다시 오면 화면의 알림을 새 내용으로 덮어쓴다. 요약은 'summary'
  const tag = ok ? (data.notificationId != null ? `n${data.notificationId}` : data.kind) : 'fallback'
  event.waitUntil(
    self.registration.showNotification(shown.title, {
      body: typeof shown.body === 'string' ? shown.body : '',
      tag,
      renotify: true, // 덮어쓸 때도 다시 알림음 · 진동(브라우저마다 지원이 다름 — 10절 확인 필요)
      data: { url: ok ? data.url : FALLBACK.url },
    }),
  )
})

// 2) 알림을 누르면: url이 우리 사이트와 같은 출처일 때만 그 주소, 아니면 앱 첫 화면. 열린 창이 있으면 그 창으로
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(openSameOrigin(event.notification.data && event.notification.data.url))
})

async function openSameOrigin(rawUrl) {
  let target = new URL('/', self.location.origin)
  try {
    const candidate = new URL(rawUrl, self.location.origin)
    if (candidate.origin === self.location.origin) target = candidate
  } catch {
    // 형식이 틀리면 첫 화면
  }
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const existing = windows.find((client) => new URL(client.url).origin === self.location.origin)
  if (existing) {
    await existing.focus()
    return existing.navigate(target.href)
  }
  return self.clients.openWindow(target.href)
}

// 3) 브라우저가 구독을 바꾸면(만료 · 갱신) 새 구독을 백엔드에 다시 등록한다(로그인 세션 쿠키가 있으면 성공, 없으면 401 → 다음에 앱을 열 때 다시 등록)
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribe(event))
})

async function resubscribe(event) {
  const subscription = event.newSubscription || (await subscribeAgain())
  if (!subscription) return
  await fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(subscription),
  })
}

async function subscribeAgain() {
  const res = await fetch('/api/push/public-key')
  if (!res.ok) return null
  const { publicKey } = await res.json()
  return self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) })
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}
```

- 알림 제목 · 본문은 `textContent`처럼 그대로 문자열로만 쓴다(HTML로 해석하지 않음 — `showNotification`은 원래 글자만 보여 준다)
- `pushsubscriptionchange`는 브라우저마다 보내는 때가 달라(10절 확인 필요) **3절의 "앱을 열 때마다 다시 등록"이 실제 안전장치**다

## 3. 구독 흐름 (앱 코드)

### 원칙

- **알림 권한 요청은 사용자가 버튼을 눌렀을 때만.** 페이지를 열자마자 `Notification.requestPermission()`을 부르지 않는다(브라우저가 막거나 사용자가 거부하기 쉽고, iPhone은 사용자 동작 없이 요청할 수 없다)
- 로그인한 뒤에만 등록한다(`POST /api/push/subscriptions`는 로그인 필요)

### 켜기 (설정 화면의 "푸시 알림 켜기" 버튼)

```js
// 예시: 버튼 클릭 핸들러 안에서만 부른다
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' } // iPhone이면 5절(홈 화면에 추가) 안내
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: permission } // 'denied'면 브라우저 설정에서만 다시 켤 수 있음

  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const keyRes = await fetch('/api/push/public-key')
  if (keyRes.status === 503) return { ok: false, reason: 'push_unavailable' }
  const { publicKey } = await keyRes.json()

  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }))

  const res = await fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(subscription), // toJSON(): { endpoint, expirationTime, keys: { p256dh, auth } } — 그대로 보낸다
  })
  return res.ok ? { ok: true } : { ok: false, reason: (await res.json()).error } // 201(새로) · 200(갱신) 모두 성공
}
```

- `base64UrlToBytes`는 2절과 같은 함수(앱 코드에도 둔다)
- 응답 본문은 `{}`. 구독 주소 · 키는 서버가 암호화해 저장하고 응답 · 로그에 남기지 않는다

### 앱을 열 때마다 (로그인 상태)

로그인 상태로 앱이 열릴 때(예: `GET /api/auth/me` 성공 뒤) **현재 구독이 있으면 다시 `POST`** 한다. 권한 요청은 하지 않는다.

```js
async function refreshPushOnOpen() {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return
  const registration = await navigator.serviceWorker.getRegistration('/')
  const subscription = registration && (await registration.pushManager.getSubscription())
  if (!subscription) return
  await fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(subscription),
  })
}
```

왜 매번 다시 보내나

- **주인 이전**: 같은 브라우저에서 다른 계정으로 로그인하면, 이 `POST`로 그 구독이 지금 계정 것이 된다(이전 계정의 알림이 이 브라우저로 가지 않게)
- **키 변경 · 서버 쪽 삭제 대비**: 브라우저가 구독 키를 바꿨거나, 서버가 구독을 지웠더라도(만료 404 · 410, 계정당 10개 초과로 교체) 다시 살아난다
- 같은 구독을 여러 번 보내도 행은 하나(200 갱신)

### 끄기 (설정 화면의 "푸시 알림 끄기")

4절의 ① · ②와 같다(로그아웃은 하지 않음).

## 4. 로그아웃 순서

**로그아웃 API(`POST /api/auth/logout`)를 부르기 전에** 반드시:

1. **`pushSubscription.unsubscribe()`** (브라우저에서)
2. **`DELETE /api/push/subscriptions`** `{ endpoint }` (서버에서 이 브라우저 구독 지우기)
3. 그다음 `POST /api/auth/logout`

```js
async function logoutWithPush() {
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : null
  const subscription = registration && (await registration.pushManager.getSubscription())
  if (subscription) {
    const { endpoint } = subscription
    await subscription.unsubscribe().catch(() => {}) // ① 먼저: 서버가 실패해도 이 브라우저로는 더 안 옴
    await fetch('/api/push/subscriptions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ endpoint }),
    }).catch(() => {}) // ② 실패해도(세션 만료 401 · 네트워크) 로그아웃은 계속
  }
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}
```

왜 이 순서인가

- **①이 핵심이다.** `unsubscribe()`는 서버 · 세션 없이 브라우저가 푸시 서비스의 구독을 직접 끊는다. 그래서 ②가 실패해도(세션이 이미 만료돼 401, 네트워크 오류) **이 브라우저로는 알림이 더 오지 않는다.** 공용 컴퓨터에서 로그아웃한 뒤 남의 알림이 뜨는 것을 막는다
- ②는 서버의 구독 행을 바로 정리한다. ②가 실패해 남은 행은, 다음 발송 때 푸시 서비스가 404 · 410을 돌려주면 백엔드가 지운다
- ②는 로그인 세션이 필요하므로 **로그아웃 API보다 먼저** 부른다(`endpoint`는 ① 전에 꺼내 둔다)
- 안전장치: 같은 브라우저에서 다른 계정이 로그인해 구독을 등록하면 그 구독의 주인이 바뀌어(3절), 이전 계정의 알림은 그 브라우저로 가지 않는다

## 5. 아이폰 · 아이패드 체크리스트

| 항목 | 내용 |
| --- | --- |
| OS 버전 | **iOS · iPadOS 16.4 이상** |
| 홈 화면에 추가 | Safari에서 "홈 화면에 추가"한 **웹앱에서만** 푸시가 된다(일반 Safari 탭에서는 `PushManager`가 없음). 웹앱이 아니면 "홈 화면에 추가하면 알림을 받을 수 있어요" 같은 안내를 보여 준다 |
| manifest | `manifest.json`(또는 `.webmanifest`)에 `"display": "standalone"`(또는 `fullscreen`), `name` · `start_url` · 아이콘. `<link rel="manifest" href="/manifest.json">` |
| 권한 요청 | **사용자 동작(버튼 누름)에 대한 응답으로만** `Notification.requestPermission()` — 그 밖에서는 요청할 수 없다 |
| HTTPS | 필요. 실기기 확인은 배포 서버(https)에서 한다(아이폰은 개발 PC의 localhost에 붙지 않음) |
| Apple 계정 | 개발자 프로그램 가입 필요 없음 |

출처: WebKit 블로그 "Web Push for Web Apps on iOS and iPadOS"(iOS · iPadOS 16.4, 홈 화면 웹앱, 사용자 동작으로 권한 요청). `display` 값은 standalone · fullscreen이 웹앱으로 열리는 값 — **실기기로 확인 필요**

## 6. 배포 참고 (서버 담당)

- `sw.js`는 **사이트 루트**에서 제공한다(`https://도메인/sw.js`). 서비스 워커는 자기 파일 경로 아래만 맡으므로, `/assets/sw.js`처럼 두면 앱 전체를 맡지 못한다
- **오래 캐시되지 않게**: `sw.js` 응답에 `Cache-Control: no-cache`(또는 `max-age=0`). 브라우저는 서비스 워커 갱신을 확인하지만, 앞단 캐시가 오래 붙잡으면 고친 `sw.js`가 늦게 퍼진다. 파일 이름에 해시를 붙이지 않는다(주소가 바뀌면 새 서비스 워커로 취급)
  - nginx 예: `location = /sw.js { add_header Cache-Control "no-cache"; }` (지금 `deploy/deploy.sh`의 nginx 설정에는 없음 — 넣을 때 서버 담당과 확인)
- `Content-Type: text/javascript`(또는 `application/javascript`)로 제공
- `manifest.json`도 루트에 두면 편하다(5절)
- 백엔드 쪽: 서버 `.env`에 VAPID 키 3개가 있어야 서버가 시작한다(README). 공개키를 바꾸면 모든 브라우저가 다시 구독해야 한다

## 7. 오류 처리

코드는 [api.md](api.md)와 같다. 모두 `{ error, message }`(입력 오류는 `field`도).

| 상황 | 응답 | 프론트에서 |
| --- | --- | --- |
| 로그인 안 됨 · 세션 만료 | 401 `not_authenticated` (등록 · 해제 · 테스트 발송) | 등록은 로그인 뒤 다시(3절 "앱을 열 때마다"가 처리). 로그아웃 중 해제 실패는 무시하고 진행(4절) |
| 서버에 푸시 설정 없음 | 503 `push_unavailable` (공개키 포함 푸시 API 전체) | 푸시 켜기 버튼을 숨기거나 "지금은 쓸 수 없음". 운영 서버에서는 나오지 않음(설정 없으면 서버가 안 뜸) |
| 구독 주소 문제 | 400 `missing_endpoint` · `invalid_endpoint` · `insecure_endpoint` · `endpoint_too_long` · `push_service_not_allowed` (`field: endpoint`) | 대부분 프론트 버그거나 지원하지 않는 브라우저. "이 브라우저에서는 푸시를 켤 수 없어요" |
| 구독 키 문제 | 400 `missing_keys` · `invalid_p256dh` · `invalid_auth` (`field: keys…`) | 프론트 버그. `subscription` 객체를 `JSON.stringify` 그대로 보낸다 |
| 해제할 구독이 없음 | 404 `push_subscription_not_found` | 이미 지워진 것으로 보고 넘어간다 |
| 권한 거부 | (브라우저) `Notification.permission === 'denied'` | 다시 요청해도 안 뜬다. "브라우저 설정에서 알림을 허용해 주세요" 안내 |
| 계정당 구독 10개 초과 | 오류 아님(201) | 서버가 가장 오래 성공 못 한 구독을 바꿔 넣는다 |

## 8. 받는 내용 (payload)

서비스 워커의 `event.data.json()`:

```json
{ "v": 1, "notificationId": 31, "kind": "assignment_due_changed", "title": "마감 변경", "body": "자료구조 · 과제 1 · 11/27 23:59", "url": "/?view=notifications" }
```

| 칸 | 설명 |
| --- | --- |
| `v` | 형식 버전. 지금 `1`. 다르면 2절처럼 기본 알림 |
| `notificationId` | 앱 안 알림 id(`GET /api/notifications`의 id). 요약 · 테스트는 `null` |
| `kind` | 알림 종류(api.md의 알림 `kind`와 같음) 또는 `summary`(한 번에 4개 이상) · `test` |
| `title` | 고정 문구: 새 과제 · 마감 변경 · 과제 이름 변경 · 과제 삭제 · 새 공지 · 공지 수정 · 새 알림 N개 · 테스트 알림 |
| `body` | "과목 · 제목"(마감 변경 · 새 과제는 뒤에 새 마감 서울 시각 `M/D HH:mm`). 요약은 안내 문구. **공지 본문은 들어 있지 않다**(잠금 화면에 보이므로) |
| `url` | 눌렀을 때 열 앱 안 경로(같은 출처의 상대 경로). 지금 임시 값 — 10절 |
| `count` | 요약일 때만, 알림 개수 |

- 한 동기화에 알림이 4개 이상이면 구독마다 요약 하나만 온다(쏟아지지 않게)
- 안 읽은 같은 알림이 다시 바뀌면(예: 마감이 또 바뀜) 같은 `notificationId`로 다시 온다 → `tag`가 같아 화면의 알림이 새 내용으로 바뀐다
- 크기는 1024바이트 이하, 푸시 서비스에서 최대 1일 보관(그 안에 기기가 안 켜지면 버려짐 — 앱 안 알림 목록에는 남아 있음)

## 9. 개발 중 확인하기

- 개발 서버에서 `POST /api/push/test`(로그인 필요, 본문 없음) → 202 `{ "queued": n }` → 내 구독마다 `{ kind: "test", title: "테스트 알림" }`이 온다. **운영 서버에는 이 경로가 없다**(404)
- Chrome 개발자 도구 → Application → Service Workers에서 등록 · "Push" 버튼(임의 내용 보내기, 2절의 기본 알림이 떠야 함), Push Messaging 기록
- 로컬은 `http://localhost`에서 된다. 다른 기기(아이폰 등)는 https 배포 서버에서

## 10. 열린 질문 · 확인 필요

- **알림 화면 URL** (프론트 담당과 정할 것): 지금 프론트는 URL 경로 없이 화면 상태로 바뀐다. payload의 `url`은 **임시로 `/?view=notifications`**. 정할 것: 경로 이름(예: `/notifications`), 알림 하나를 바로 열지(`notificationId` 사용) 목록만 열지. 정해지면 백엔드 한 곳(`src/push/push-payload.js`)을 바꾼다
- **Chrome 구독 주소의 호스트**: `fcm.googleapis.com`으로 **확정**(2026-11-18 실제 Chrome 구독으로 확인, 허용 목록 그대로). Opera · Samsung Internet 같은 다른 Chromium 계열은 실제 구독으로 **확인 필요**(목록 밖이면 400 `push_service_not_allowed` — 그 브라우저의 `endpoint` 호스트를 알려 주면 추가한다)
- **확인 필요**: `renotify`(덮어쓸 때 다시 알림음) · `pushsubscriptionchange`를 브라우저(특히 Safari)가 어떻게 처리하는지 — 3절의 "앱을 열 때마다 다시 등록"이 있으므로 기능이 없어도 알림은 계속 온다
- **확인 필요**: iPhone 웹앱의 `display` 값 · 아이콘 요구 사항(5절), 실기기 확인 전
