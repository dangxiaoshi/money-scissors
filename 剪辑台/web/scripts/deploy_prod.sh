#!/usr/bin/env sh
set -eu

# 部署到【正式环境】，学员正在使用，慎之又慎。
# 目标：/opt/money-scissors-m2 ｜ PM2 money-scissors-m2 ｜ 端口 3002
#
# 纪律（对应需求文档第 7 节）：
#   1. 必须显式确认才会执行，避免“脚本一跑就动正式”。
#   2. 部署前跑 check_release（语法 + 密钥扫描）和 production 预检。
#   3. 部署后跑 smoke test，挂了立刻能发现。
#
# 用法：
#   MONEY_SCISSORS_CONFIRM_PROD=1 sh scripts/deploy_prod.sh
# 没有这个确认变量时，脚本拒绝执行，只打印提示。

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PUBLIC_URL="${MONEY_SCISSORS_PUBLIC_URL:-http://8.136.133.196}"

if [ "${MONEY_SCISSORS_CONFIRM_PROD:-0}" != "1" ]; then
  echo "拒绝执行：这是正式环境部署。" >&2
  echo "确认本地改动都已在测试环境 /web-test/ 验收通过后，再这样执行：" >&2
  echo "  MONEY_SCISSORS_CONFIRM_PROD=1 sh scripts/deploy_prod.sh" >&2
  exit 1
fi

echo "==> 目标：正式环境 /opt/money-scissors-m2 (PM2 money-scissors-m2, 端口 3002)"
echo "==> 提醒：rsync 会把当前本地 web/ 目录同步到正式环境。"
echo "    请先确认没有未验收的半成品改动被一起带上去（git status 应当干净或只含已确认改动）。"

echo ""
echo "==> 步骤 1/3：发布前检查（语法 + 密钥扫描）"
sh "$ROOT/scripts/check_release.sh"

echo ""
echo "==> 步骤 2/3：部署到正式环境（含 production 预检 + 服务器本机 3002 健康检查）"
MONEY_SCISSORS_REMOTE_DIR="${MONEY_SCISSORS_REMOTE_DIR:-/opt/money-scissors-m2}" \
MONEY_SCISSORS_PM2_NAME="${MONEY_SCISSORS_PM2_NAME:-money-scissors-m2}" \
MONEY_SCISSORS_REMOTE_PORT="${MONEY_SCISSORS_REMOTE_PORT:-3002}" \
MONEY_SCISSORS_PREFLIGHT_MODE="${MONEY_SCISSORS_PREFLIGHT_MODE:-production}" \
  sh "$ROOT/scripts/deploy_ecs.sh"

echo ""
echo "==> 步骤 3/3：正式环境 smoke test（$PUBLIC_URL）"
sh "$ROOT/scripts/smoke_test.sh" "$PUBLIC_URL"

echo ""
echo "==> 正式环境部署完成并通过 smoke test。"
echo "    请再用浏览器实测核心路径：登录 / 上传 / 最近项目 / 审核入口。"
