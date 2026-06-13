#!/usr/bin/env sh
# 三边对账：本地 / 测试站 / 正式站 文件指纹比对。
# 只读脚本，不改本地、不改服务器、不碰数据。
# 用法：sh scripts/check_sync.sh
set -eu

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
PROD_DIR="${MONEY_SCISSORS_REMOTE_DIR:-/opt/money-scissors-m2}"
TEST_DIR="${MONEY_SCISSORS_TEST_DIR:-/opt/money-scissors-test}"
WEB_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

cd "$WEB_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 对账范围：git 跟踪的文件（自动排除 data/、logs/、uploads/、node_modules 等不入库内容）
git ls-files -- . > "$TMP/files.txt"
TOTAL=$(wc -l < "$TMP/files.txt" | tr -d ' ')
echo "对账范围：$TOTAL 个文件（git 跟踪的源码文件）"

# 本地指纹
while IFS= read -r f; do
  md5 -q "$f"
done < "$TMP/files.txt" > "$TMP/local.txt"

# 服务器指纹（一次 ssh 拿两个目录，缺失文件标 MISSING）
ssh -i "$KEY" "$HOST" "
  while IFS= read -r f; do
    if [ -f \"$PROD_DIR/\$f\" ]; then md5sum \"$PROD_DIR/\$f\" | cut -d' ' -f1; else echo MISSING; fi
  done < /dev/stdin
" < "$TMP/files.txt" > "$TMP/prod.txt"

ssh -i "$KEY" "$HOST" "
  while IFS= read -r f; do
    if [ -f \"$TEST_DIR/\$f\" ]; then md5sum \"$TEST_DIR/\$f\" | cut -d' ' -f1; else echo MISSING; fi
  done < /dev/stdin
" < "$TMP/files.txt" > "$TMP/test.txt"

# 汇总
paste "$TMP/files.txt" "$TMP/local.txt" "$TMP/prod.txt" "$TMP/test.txt" | awk -F'\t' '
  $2==$3 && $2==$4 { ok++; next }
  {
    bad++
    p = ($2==$3) ? "正式=本地" : (($3=="MISSING") ? "正式缺失" : "正式≠本地")
    t = ($2==$4) ? "测试=本地" : (($4=="MISSING") ? "测试缺失" : "测试≠本地")
    printf "⚠️  %s  [%s | %s]\n", $1, p, t
  }
  END {
    print "----------------------------------------"
    printf "✅ 三边一致：%d 个\n", ok
    if (bad) printf "⚠️ 不一致：%d 个（明细见上）\n", bad
    else print "🎉 本地、测试站、正式站完全一致"
  }
'
