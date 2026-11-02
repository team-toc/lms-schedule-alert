# 처음 시작하기

처음 한 번만 하는 것(1~3)과 작업할 때마다 하는 것(4~8)으로 나뉜다. 순서대로 따라 하면 된다.

## 1. 설치

- Git: https://git-scm.com/downloads (설치 중 옵션은 전부 기본값)
- Node.js: https://nodejs.org 에서 LTS (20 이상)
- VS Code: https://code.visualstudio.com

설치 확인. 터미널(VS Code 메뉴 터미널 → 새 터미널)에서:

```bash
git --version
node --version
```

Git 이름·메일 설정(GitHub 가입 메일과 같게):

```bash
git config --global user.name "본인 GitHub 아이디"
git config --global user.email "가입한 메일"
```

## 2. 레포 받기

```bash
git clone https://github.com/team-toc/lms-schedule-alert.git
cd lms-schedule-alert
```

처음 push할 때 GitHub 로그인 창이 뜨면 브라우저로 로그인한다.

## 3. 실행해 보기

터미널 두 개를 연다.

터미널 1 (백엔드):
```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

터미널 2 (프론트엔드):
```bash
cd frontend
npm install
npm run dev
```

브라우저에서 http://localhost:5173 을 열어 Vite + React 기본 화면이 보이면 끝. http://localhost:4000/api/health 도 열어 `{"ok":true,...}`가 보이는지 확인한다.

## 4. 작업 시작 (매번)

```bash
git checkout develop
git pull
git checkout -b feature/기능이름
```

브랜치 이름은 영어 소문자, 예: `feature/login`, `feature/alert-list`.

## 5. 코드 고치기

VS Code에서 수정하고 저장. 브라우저가 자동으로 새로고침된다.

## 6. 커밋

```bash
git add .
git commit -m "feat: 알림 목록 화면"
```

메시지 형식은 `종류: 내용`. 종류는 feat(기능) / fix(수정) / docs(문서) / chore(설정). 자세한 건 CONTRIBUTING.md.

## 7. 올리기

```bash
git push -u origin feature/기능이름
```

두 번째부터는 `git push`만.

## 8. PR 만들기

1. https://github.com/team-toc/lms-schedule-alert 에 가면 위에 노란 띠로 "Compare & pull request" 버튼이 뜬다. 누른다.
2. base가 `develop`인지 확인한다. (`main` 아님)
3. 제목은 커밋 메시지처럼. 본문 칸(무엇을 했나 / 어떻게 확인했나) 채운다.
4. 오른쪽 Reviewers에서 팀원 1명 고른다.
5. Create pull request.

리뷰에서 Approve가 되면 "Merge pull request" 누르고, "Delete branch"도 누른다.

## 9. 다음 작업

다시 4번부터. 항상 `develop`을 `pull` 한 뒤에 새 브랜치를 만든다.

## 자주 생기는 문제

- `npm run dev`가 안 됨 → 그 폴더에서 `npm install`을 먼저 했는지 확인.
- http://localhost:4000/api/health 가 안 열림 → backend 터미널이 꺼져 있음.
- push가 거부됨(`main`/`develop`) → 직접 push는 막혀 있다. 브랜치를 만들어서 PR로.
- 충돌(conflict) → 당황하지 말고 팀 채팅에 올리기. 같이 푼다.
