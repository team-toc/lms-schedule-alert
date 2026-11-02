# backend

Node.js + Express API 서버.

## 실행

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

http://localhost:4000/api/health 를 열어 `{"ok":true,...}`가 보이면 된다.

`.env`는 커밋하지 않는다. 새 설정값이 생기면 `.env.example`에 이름만 추가한다.

## 구조

```
src/
└─ index.js     서버 시작 · 라우트 등록
```

라우트가 늘어나면 `src/routes/` 폴더로 나눈다.
