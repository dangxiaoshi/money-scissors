#!/usr/bin/env sh
set -eu

# 部署到【测试环境】，绝不碰正式环境。
# 目标：/opt/money-scissors-test ｜ PM2 money-scissors-test ｜ 端口 3004
# 验证入口：http://8.136.133.196/web-test/
#
# 这是 deploy_ecs.sh 的薄封装：把目标目录、PM2 进程名、端口改成测试环境，
# 并用 dev 预检（测试环境不强制 https、不强制 .env 600 权限）。
# deploy_ecs.sh 内部会自动跑 check_release（语法 + 密钥扫描）和 preflight，
# 部署后会在服务器本机校验 http://127.0.0.1:3004/api/health。

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

echo "==> 目标：测试环境 /opt/money-scissors-test (PM2 money-scissors-test, 端口 3004)"

MONEY_SCISSORS_REMOTE_DIR="${MONEY_SCISSORS_REMOTE_DIR:-/opt/money-scissors-test}" \
MONEY_SCISSORS_PM2_NAME="${MONEY_SCISSORS_PM2_NAME:-money-scissors-test}" \
MONEY_SCISSORS_REMOTE_PORT="${MONEY_SCISSORS_REMOTE_PORT:-3004}" \
MONEY_SCISSORS_PREFLIGHT_MODE="${MONEY_SCISSORS_PREFLIGHT_MODE:-dev}" \
  sh "$ROOT/scripts/deploy_ecs.sh"

echo ""
echo "==> 测试环境部署完成。"
echo "    服务器本机健康检查已通过：http://127.0.0.1:3004/api/health"
echo "    请用浏览器实测：http://8.136.133.196/web-test/"
echo "    （/web-test/ 能否打开取决于服务器 Nginx 是否已把 /web-test/ 转发到 127.0.0.1:3004）"
