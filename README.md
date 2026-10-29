# 일정 변동 알림 (plan-ping)

대학 이러닝 시스템(LMS)의 공지·과제·일정 변경을 받아와 내 캘린더에 반영하고, 바뀐 일정과 겹치는 일정을 알려 주는 앱.

## 팀

| 이름 | 역할 |
|---|---|
| 박수빈 | PM · 서버 · 프론트엔드 |
| 임지언 | 프론트엔드 · 백엔드 |
| 이영민 | 백엔드 |

## 기술

- 프론트엔드: React (Vite)
- 백엔드: Node.js (Express)
- 데이터베이스: MariaDB
- 연동: Canvas LMS API, Google Calendar API, 카카오 톡캘린더 API, iCal(.ics)

세부 라이브러리는 개발 환경을 구성하면서 확정한다.

## 폴더

```
plan-ping/
├─ frontend/   React 앱
├─ backend/    Express API 서버
└─ docs/       ERD · DFD · 회의록 · 설계 문서
```

## 시작하기

```bash
git clone https://github.com/team-toc/plan-ping.git
cd plan-ping
git checkout develop
```

프론트엔드·백엔드 실행 방법은 각 폴더의 README에 적는다.

## 협업 규칙

브랜치·커밋·PR 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)를 따른다.
