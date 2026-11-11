#!/usr/bin/env bash
# 일정 변동 알림 — AWS EC2(toc-schedule.kro.kr) 에 우리 코드 배포
#   bash deploy/deploy.sh            (키: ~/.ssh/lms-schedule-alert.pem, 다른 곳이면 KEY=경로 bash deploy/deploy.sh)
#   로컬에 node 20+ · git · ssh · tar 가 있으면 된다. 레포 어디서 실행해도 됨.
#  · 프론트: develop + feature/login-ui 를 합쳐 Vite 빌드 → nginx 가 주는 폴더
#  · 백엔드: develop(PR #1 머지본) → /srv/lms-schedule-alert/backend, Node 22, systemd(lms-backend) 4000 포트
#  · DB: 서버 MariaDB 에 앱 계정 · DB 가 없으면 만들고 .env 작성(있으면 그대로 둠) → npm run migrate
#  · nginx: /api 프록시가 없으면 추가. 여러 번 돌려도 같은 결과.
set -euo pipefail
KEY="${KEY:-$HOME/.ssh/lms-schedule-alert.pem}"
VM="ubuntu@54.116.173.97"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WT="$(mktemp -d)/wt"
[ -f "$KEY" ] || { echo "키 파일이 없음: $KEY  (메인PC C:\\Users\\Administrator\\.ssh\\lms-schedule-alert.pem 을 복사)"; exit 1; }

echo "== 1. 코드 준비 (develop + feature/login-ui)"
git -C "$REPO" fetch -q origin
git -C "$REPO" worktree add -q "$WT" origin/develop
git -C "$WT" -c user.name=deploy -c user.email=deploy@local merge -q --no-edit origin/feature/login-ui
( cd "$WT/frontend" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null && sed -i 's#<title>Vite + React</title>#<title>일정 변동 알림</title>#' dist/index.html )
echo "   프론트 빌드 OK: $(ls "$WT/frontend/dist/assets" | tr '\n' ' ')"

echo "== 2. 서버로 복사"
tar -czf - -C "$WT" backend/src backend/migrations backend/scripts backend/package.json backend/package-lock.json backend/docs -C "$WT/frontend" dist \
  | ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$VM" 'set -e; rm -rf /tmp/lsa && mkdir -p /tmp/lsa && tar -xzf - -C /tmp/lsa'

echo "== 3. 서버 안에서 설치 · DB · 서비스 · nginx"
ssh -i "$KEY" -o IdentitiesOnly=yes "$VM" bash -s <<'REMOTE'
set -euo pipefail
APP=/srv/lms-schedule-alert
DOMAIN=toc-schedule.kro.kr

# Node 22
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs >/dev/null
fi
echo "   node $(node -v)"

# 백엔드 코드
sudo mkdir -p $APP && sudo chown -R ubuntu:ubuntu $APP
rm -rf $APP/backend.new && mkdir -p $APP/backend.new && cp -r /tmp/lsa/backend/* $APP/backend.new/
[ -f $APP/backend/.env ] && cp $APP/backend/.env $APP/backend.new/.env || true
rm -rf $APP/backend.old; [ -d $APP/backend ] && mv $APP/backend $APP/backend.old; mv $APP/backend.new $APP/backend
cd $APP/backend && npm ci --omit=dev --no-audit --no-fund >/dev/null

# DB 계정 · .env (없을 때만)
if [ ! -f .env ]; then
  DBPW=$(openssl rand -hex 16); SS=$(openssl rand -hex 32)
  sudo mariadb <<SQL
CREATE DATABASE IF NOT EXISTS lms_schedule_alert CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'lsa'@'localhost' IDENTIFIED BY '$DBPW';
ALTER USER 'lsa'@'localhost' IDENTIFIED BY '$DBPW';
GRANT ALL ON lms_schedule_alert.* TO 'lsa'@'localhost';
FLUSH PRIVILEGES;
SQL
  cat > .env <<ENV
PORT=4000
NODE_ENV=production
TRUST_PROXY=true
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=lsa
DB_PASSWORD=$DBPW
DB_NAME=lms_schedule_alert
TEST_DB_NAME=lms_schedule_alert_test
SESSION_SECRET=$SS
FRONTEND_URL=https://$DOMAIN
# 카카오 · 구글 키는 콘솔에서 받아 채운다. 비어 있으면 서버가 안 뜨므로 임시값
KAKAO_REST_API_KEY=not-set
KAKAO_CLIENT_SECRET=not-set
KAKAO_REDIRECT_URI=https://$DOMAIN/api/auth/kakao/callback
GOOGLE_CLIENT_ID=not-set
GOOGLE_CLIENT_SECRET=not-set
GOOGLE_REDIRECT_URI=https://$DOMAIN/api/auth/google/callback
ENV
  chmod 600 .env
  echo "   .env 새로 작성 (DB 사용자 lsa)"
fi
npm run migrate 2>&1 | tail -1

# systemd
sudo tee /etc/systemd/system/lms-backend.service >/dev/null <<UNIT
[Unit]
Description=lms-schedule-alert backend
After=network.target mariadb.service
[Service]
User=ubuntu
WorkingDirectory=$APP/backend
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable -q lms-backend && sudo systemctl restart lms-backend
sleep 2; curl -sf http://127.0.0.1:4000/api/health >/dev/null && echo "   backend 4000 OK" || { sudo journalctl -u lms-backend -n 20 --no-pager; exit 1; }

# 프론트: nginx 가 주는 root 찾기
CONF=$(grep -l "$DOMAIN" /etc/nginx/sites-enabled/* | head -1)
ROOT=$(grep -m1 -E '^\s*root ' "$CONF" | awk '{print $2}' | tr -d ';')
echo "   nginx conf $CONF  root $ROOT"
sudo rm -rf "$ROOT.old"; [ -d "$ROOT" ] && sudo cp -r "$ROOT" "$ROOT.old"
sudo rm -rf "$ROOT"/* && sudo cp -r /tmp/lsa/dist/* "$ROOT"/ && sudo chmod -R a+rX "$ROOT"
if ! grep -q 'location /api' "$CONF"; then
  sudo cp "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M)"
  sudo sed -i '0,/location \/ {/s##location /api/ { proxy_pass http://127.0.0.1:4000; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header X-Forwarded-For $remote_addr; }\n    location / {#' "$CONF"
fi
sudo nginx -t && sudo systemctl reload nginx
echo "   done"
REMOTE

git -C "$REPO" worktree remove --force "$WT"
echo "== 4. 밖에서 확인"
curl -sk https://toc-schedule.kro.kr/api/health; echo
curl -sk https://toc-schedule.kro.kr/ | grep -o '<title>[^<]*</title>'
echo "https://toc-schedule.kro.kr/"
