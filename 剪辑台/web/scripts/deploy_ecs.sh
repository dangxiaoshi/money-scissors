#!/usr/bin/env sh
set -eu

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
REMOTE_DIR="${MONEY_SCISSORS_REMOTE_DIR:-/opt/money-scissors-m2}"
PM2_NAME="${MONEY_SCISSORS_PM2_NAME:-money-scissors-m2}"
REMOTE_PORT="${MONEY_SCISSORS_REMOTE_PORT:-3002}"
LOCAL_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

sh "$LOCAL_DIR/scripts/check_release.sh"
sh "$LOCAL_DIR/scripts/preflight_ecs.sh"

ssh -i "$KEY" "$HOST" "mkdir -p '$REMOTE_DIR.releases' && tar -C '$REMOTE_DIR' -czf '$REMOTE_DIR.releases/backup-$(date +%Y%m%d-%H%M%S).tgz' --exclude node_modules --exclude data --exclude logs --exclude public/uploads ."

rsync -av --delete \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude 'logs' \
  --exclude 'uploads' \
  --exclude 'public/uploads' \
  -e "ssh -i $KEY" \
  "$LOCAL_DIR/" \
  "$HOST:$REMOTE_DIR/"

ssh -i "$KEY" "$HOST" "
  set -eu
  cd '$REMOTE_DIR'
  npm ci
  pm2 restart '$PM2_NAME' --update-env
  pm2 save

  ok=''
  for i in \$(seq 1 20); do
    if curl -fsS 'http://127.0.0.1:$REMOTE_PORT/api/health' >/dev/null; then
      ok=1
      break
    fi
    sleep 1
  done

  if [ -z \"\$ok\" ]; then
    echo 'Deploy failed: local health check did not pass on http://127.0.0.1:$REMOTE_PORT/api/health' >&2
    echo 'Recent PM2 logs:' >&2
    pm2 logs '$PM2_NAME' --lines 40 --nostream >&2 || true
    exit 1
  fi

  echo 'Deploy health check passed: http://127.0.0.1:$REMOTE_PORT/api/health'
"
