# 협업 규칙

## 브랜치 (Git Flow 간소판)

Git Flow에서 release·hotfix를 뺀 형태. 3명 팀이라 세 종류면 충분하다.


| 브랜치 | 용도 | 규칙 |
|---|---|---|
| `main` | 발표·제출용. 항상 돌아가는 상태 | 직접 push 금지. `develop`에서 PR로만 합침 |
| `develop` | 개발 합치는 곳. 기본 브랜치 | 직접 push 금지. `feature/*`에서 PR로만 합침 |
| `feature/기능이름` | 각자 작업 | `develop`에서 분기. 작업 끝나면 `develop`으로 PR |

브랜치 이름은 영어 소문자와 하이픈만 쓴다.

```
feature/login
feature/canvas-sync
feature/calendar-google
fix/notify-duplicate
```

## 작업 순서

1. `develop`을 최신으로 받는다. `git checkout develop` → `git pull`
2. 작업 브랜치를 만든다. `git checkout -b feature/login`
3. 작업하고 커밋한다.
4. 올린다. `git push -u origin feature/login`
5. GitHub에서 `develop`으로 PR을 만든다. PR 템플릿의 칸을 채운다.
6. 다른 팀원 1명이 확인(Approve)하면 합친다. 합친 뒤 작업 브랜치는 지운다.

## 커밋 메시지 (Conventional Commits)

`종류: 내용` 형식(Conventional Commits 기준). 내용은 한국어로 짧게.

| 종류 | 언제 |
|---|---|
| `feat` | 기능 추가 |
| `fix` | 버그 수정 |
| `docs` | 문서·README·설계 문서 |
| `style` | 코드 동작 변화 없는 정리(들여쓰기, 이름) |
| `refactor` | 구조 변경(동작 동일) |
| `chore` | 설정·패키지·빌드 |

```
feat: 로그인 화면
fix: 알림 두 번 가는 문제
docs: ERD 초안
chore: eslint 설정
```

커밋 하나에 한 가지 일만 담는다.

## PR

- 제목은 커밋 메시지와 같은 형식.
- 본문에 무엇을 했는지, 어떻게 확인했는지, 화면이 있으면 캡처를 넣는다.
- 리뷰어 1명 이상 지정. 본인 PR은 본인이 합치지 않는다.
- 충돌이 나면 PR 올린 사람이 `develop`을 받아 해결한다.

## 이슈

할 일은 이슈로 만든다. 이슈 템플릿(기능 / 버그)을 쓰고, 맡은 사람을 Assignees에 넣는다. 브랜치 이름이나 PR 본문에 `#이슈번호`를 적으면 자동으로 연결된다.

## 하지 않을 것

- `main`·`develop`에 직접 push
- `.env`, 토큰, 비밀번호, API 키 커밋 (`.gitignore`에 있음)
- `node_modules`, 빌드 결과물 커밋
- 남의 브랜치에 force push
