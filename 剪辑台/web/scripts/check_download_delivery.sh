#!/usr/bin/env sh
set -eu

# 下载导出交付闸门（P1-A）
# 用法：
#   sh scripts/check_download_delivery.sh --test   # 只跑 8090 测试站
#   sh scripts/check_download_delivery.sh --prod   # 只跑正式站
#   sh scripts/check_download_delivery.sh --all    # 测试站 + 正式站
#
# 目的：不要只看页面 200，而是真实生成并下载一份 MP3。

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
TEST_REMOTE_DIR="${MONEY_SCISSORS_TEST_REMOTE_DIR:-/opt/money-scissors-test}"
PROD_REMOTE_DIR="${MONEY_SCISSORS_PROD_REMOTE_DIR:-/opt/money-scissors-m2}"
TEST_BASE_URL="${MONEY_SCISSORS_TEST_BASE_URL:-http://8.136.133.196:8090}"
PROD_BASE_URL="${MONEY_SCISSORS_PROD_BASE_URL:-https://bokejianji.cn}"
TIMEOUT_MS="${MONEY_SCISSORS_DOWNLOAD_GUARD_TIMEOUT_MS:-900000}"
POLL_MS="${MONEY_SCISSORS_DOWNLOAD_GUARD_POLL_MS:-2000}"

MODE="${1:---test}"

case "$MODE" in
  --test|--prod|--all) ;;
  -h|--help)
    sed -n '1,14p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: sh scripts/check_download_delivery.sh [--test|--prod|--all]" >&2
    exit 1
    ;;
esac

echo "==> P1-A 下载导出交付闸门"
echo "    mode=$MODE"

echo ""
echo "==> 1/3 本地发布检查"
sh "$ROOT/scripts/check_release.sh"

echo ""
echo "==> 2/3 前端默认精修检查"
node <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('review.html', 'utf8');
const required = [
  'const REFINE_SETTINGS_VERSION = 2;',
  'normalizeLoudness: false',
  'const isCurrentVersion = Number(parsed.version) >= REFINE_SETTINGS_VERSION;',
  'normalizeLoudness: isCurrentVersion ? Boolean(parsed.normalizeLoudness) : false',
];
for (const text of required) {
  if (!html.includes(text)) throw new Error(`missing front-end guard: ${text}`);
}

const REFINE_SETTINGS_VERSION = 2;
const DEFAULT_REFINE_SETTINGS = {
  normalizeLoudness: false,
  denoise: false,
  voiceEnhance: false,
  targetLufs: -16,
  version: REFINE_SETTINGS_VERSION,
};
function loadRefineSettings(raw) {
  try {
    if (!raw) return { ...DEFAULT_REFINE_SETTINGS };
    const parsed = JSON.parse(raw);
    const isCurrentVersion = Number(parsed.version) >= REFINE_SETTINGS_VERSION;
    return {
      ...DEFAULT_REFINE_SETTINGS,
      normalizeLoudness: isCurrentVersion ? Boolean(parsed.normalizeLoudness) : false,
      denoise: Boolean(parsed.denoise),
      voiceEnhance: Boolean(parsed.voiceEnhance),
      targetLufs: -16,
      version: REFINE_SETTINGS_VERSION,
    };
  } catch {
    return { ...DEFAULT_REFINE_SETTINGS };
  }
}
const cases = [
  ['new user', null, false],
  ['old cache true without version', JSON.stringify({ normalizeLoudness: true }), false],
  ['current cache explicit true', JSON.stringify({ version: 2, normalizeLoudness: true }), true],
  ['current cache explicit false', JSON.stringify({ version: 2, normalizeLoudness: false }), false],
];
for (const [name, raw, expected] of cases) {
  const got = loadRefineSettings(raw).normalizeLoudness;
  if (got !== expected) throw new Error(`${name}: expected ${expected}, got ${got}`);
  console.log(`[refine-default] PASS ${name} => ${got}`);
}
NODE

check_health() {
  label="$1"
  base_url="$2"
  printf '[health] %s %s/api/health ... ' "$label" "$base_url"
  curl -fsS "$base_url/api/health" >/dev/null
  echo "PASS"
}

check_remote_scripts() {
  label="$1"
  remote_dir="$2"
  printf '[scripts] %s remote sentinel scripts ... ' "$label"
  ssh -i "$KEY" "$HOST" "test -f '$remote_dir/scripts/sentinel_export_check.cjs' && test -f '$remote_dir/scripts/sentinel_cut_segments_matrix.cjs'"
  echo "PASS"
}

run_sentinel() {
  label="$1"
  remote_dir="$2"
  base_url="$3"
  allow_flag="$4"
  echo ""
  echo "==> 3/3 ${label}真实导出哨兵"
  check_remote_scripts "$label" "$remote_dir"
  check_health "$label" "$base_url"
  ssh -i "$KEY" "$HOST" "cd '$remote_dir' && node scripts/sentinel_export_check.cjs --base-url '$base_url' $allow_flag --timeout-ms '$TIMEOUT_MS' --poll-ms '$POLL_MS'"
}

if [ "$MODE" = "--test" ] || [ "$MODE" = "--all" ]; then
  run_sentinel "测试站" "$TEST_REMOTE_DIR" "$TEST_BASE_URL" ""
fi

if [ "$MODE" = "--prod" ] || [ "$MODE" = "--all" ]; then
  run_sentinel "正式站" "$PROD_REMOTE_DIR" "$PROD_BASE_URL" "--allow-production"
fi

echo ""
echo "==> PASS 下载导出交付闸门通过"
