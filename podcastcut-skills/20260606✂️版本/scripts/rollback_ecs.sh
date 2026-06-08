#!/usr/bin/env sh
set -eu

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
REMOTE_DIR="${MONEY_SCISSORS_REMOTE_DIR:-/opt/money-scissors-m2}"
PM2_NAME="${MONEY_SCISSORS_PM2_NAME:-money-scissors-m2}"
BACKUP="${1:-}"

if [ -z "$BACKUP" ]; then
  echo "Usage: sh scripts/rollback_ecs.sh /opt/money-scissors-m2.releases/backup-YYYYmmdd-HHMMSS.tgz" >&2
  exit 1
fi

ssh -i "$KEY" "$HOST" "
  set -eu
  test -f '$BACKUP'
  find '$REMOTE_DIR' -mindepth 1 \
    ! -name .env \
    ! -name data \
    ! -name logs \
    ! -name node_modules \
    ! -path '$REMOTE_DIR/data/*' \
    ! -path '$REMOTE_DIR/logs/*' \
    ! -path '$REMOTE_DIR/node_modules/*' \
    -exec rm -rf {} +
  tar -C '$REMOTE_DIR' -xzf '$BACKUP'
  cd '$REMOTE_DIR' && npm ci && pm2 restart '$PM2_NAME' --update-env && pm2 save
"
