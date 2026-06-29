#!/usr/bin/env sh
set -eu

# 日常下载导出巡检（P2）
# 用法：
#   sh scripts/daily_download_watch.sh
#
# 产物：
#   logs/download-watch-latest.json
# 后台“导出健康”会读取这份最近巡检结果。

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
MODE="${MONEY_SCISSORS_DOWNLOAD_WATCH_MODE:---all}"
HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
TEST_REMOTE_DIR="${MONEY_SCISSORS_TEST_REMOTE_DIR:-/opt/money-scissors-test}"
PROD_REMOTE_DIR="${MONEY_SCISSORS_PROD_REMOTE_DIR:-/opt/money-scissors-m2}"
LOG_DIR="$ROOT/logs"
OUTPUT_FILE="$LOG_DIR/download-watch-latest.json"
TMP_OUTPUT="$(mktemp)"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
START_SECONDS="$(date '+%s')"
STATUS="pass"

mkdir -p "$LOG_DIR"

if ! sh "$ROOT/scripts/check_download_delivery.sh" "$MODE" >"$TMP_OUTPUT" 2>&1; then
  STATUS="fail"
fi

FINISHED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
END_SECONDS="$(date '+%s')"
DURATION_SECONDS=$((END_SECONDS - START_SECONDS))

DOWNLOAD_WATCH_STATUS="$STATUS" \
DOWNLOAD_WATCH_MODE="$MODE" \
DOWNLOAD_WATCH_STARTED_AT="$STARTED_AT" \
DOWNLOAD_WATCH_FINISHED_AT="$FINISHED_AT" \
DOWNLOAD_WATCH_DURATION_SECONDS="$DURATION_SECONDS" \
DOWNLOAD_WATCH_OUTPUT_FILE="$TMP_OUTPUT" \
DOWNLOAD_WATCH_JSON_FILE="$OUTPUT_FILE" \
node <<'NODE'
const fs = require('fs');
const text = fs.readFileSync(process.env.DOWNLOAD_WATCH_OUTPUT_FILE, 'utf8');
const lines = text.trim().split(/\r?\n/).filter(Boolean);
const result = {
  status: process.env.DOWNLOAD_WATCH_STATUS,
  mode: process.env.DOWNLOAD_WATCH_MODE,
  startedAt: process.env.DOWNLOAD_WATCH_STARTED_AT,
  finishedAt: process.env.DOWNLOAD_WATCH_FINISHED_AT,
  durationSeconds: Number(process.env.DOWNLOAD_WATCH_DURATION_SECONDS || 0),
  summary: lines.slice(-12).join('\n').slice(0, 1000),
};
fs.writeFileSync(process.env.DOWNLOAD_WATCH_JSON_FILE, JSON.stringify(result, null, 2));
NODE

sync_result() {
  label="$1"
  remote_dir="$2"
  printf '[watch] sync %s result ... ' "$label"
  ssh -i "$KEY" "$HOST" "mkdir -p '$remote_dir/logs'"
  scp -i "$KEY" "$OUTPUT_FILE" "$HOST:$remote_dir/logs/download-watch-latest.json" >/dev/null
  echo "PASS"
}

if [ "$MODE" = "--test" ] || [ "$MODE" = "--all" ]; then
  sync_result "测试站" "$TEST_REMOTE_DIR"
fi

if [ "$MODE" = "--prod" ] || [ "$MODE" = "--all" ]; then
  sync_result "正式站" "$PROD_REMOTE_DIR"
fi

cat "$TMP_OUTPUT"
rm -f "$TMP_OUTPUT"

if [ "$STATUS" != "pass" ]; then
  exit 1
fi
