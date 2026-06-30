#!/usr/bin/env sh
set -eu

# 金钱剪刀磁盘健康检查（H1）
#
# 默认检查正式服务器根盘，超过 80% 返回失败：
#   sh scripts/check_disk_health.sh

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
THRESHOLD="${MONEY_SCISSORS_DISK_THRESHOLD:-80}"
PATH_TO_CHECK="${MONEY_SCISSORS_DISK_PATH:-/}"

ssh -i "$KEY" "$HOST" "THRESHOLD='$THRESHOLD' PATH_TO_CHECK='$PATH_TO_CHECK' sh -s" <<'SH'
set -eu

usage="$(df -P "$PATH_TO_CHECK" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
echo "disk_usage=${usage}% threshold=${THRESHOLD}% path=${PATH_TO_CHECK}"
df -h "$PATH_TO_CHECK"

if [ "$usage" -ge "$THRESHOLD" ]; then
  echo ""
  echo "Top disk usage:"
  du -xhd1 / 2>/dev/null | sort -h | tail -20
  echo "Disk usage is above threshold." >&2
  exit 1
fi

echo "Disk health passed."
SH
