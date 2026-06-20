#!/usr/bin/env bash
# 金钱剪刀 · 开工前自检
# 用途：每轮 AI / 当当 开工前先跑一遍，确认环境健康、知道现在该接哪一步。
# 设计成「报告式」：每项打 ✓/✗ 但不中断，最后给一句总结。
# 它只做只读检查（版本、语法、health、对账），不改任何东西、不部署、不 SSH。

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
WEB="$ROOT/剪辑台/web"
ok="✓"; bad="✗"; warn="·"

echo "=================================================="
echo " 金钱剪刀 开工自检   $(date '+%Y-%m-%d %H:%M:%S')"
echo " 仓库根：$ROOT"
echo "=================================================="

# 1) node 在不在
if command -v node >/dev/null 2>&1; then
  echo "$ok node $(node --version)"
else
  echo "$bad node 没装，后端相关检查跳过"
fi

# 2) server.cjs 语法（坏了就别在坏代码上叠 bug）
if [ -f "$WEB/server.cjs" ] && command -v node >/dev/null 2>&1; then
  if node --check "$WEB/server.cjs" 2>/dev/null; then
    echo "$ok server.cjs 语法 OK"
  else
    echo "$bad server.cjs 语法报错 —— 先别开工，先修语法"
  fi
fi

# 3) 健康检查（正式 + 测试，只读）
check_health () {
  local name="$1" url="$2"
  local code
  code=$(curl -s -o /dev/null -m 8 -w "%{http_code}" "$url" 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "$ok $name health 200  ($url)"
  else
    echo "$bad $name health=$code  ($url) —— 服务器可能异常，开工要谨慎"
  fi
}
check_health "正式站" "https://bokejianji.cn/api/health"
check_health "测试站" "http://8.136.133.196:8090/api/health"

# 4) 三边对账（只读，差异是信息不是错误）
if [ -f "$WEB/scripts/check_sync.sh" ]; then
  echo "--- 本地/测试/正式 对账（check_sync.sh 末尾）---"
  sh "$WEB/scripts/check_sync.sh" 2>/dev/null | tail -8 || echo "$warn check_sync 跑不动，手动确认"
else
  echo "$warn 没找到 check_sync.sh"
fi

# 5) 当前该接哪一步（提醒读 harness）
echo "--------------------------------------------------"
echo "下一步看这两个文件："
echo "  · feature_list.json  —— 选一个未完成任务（夜间只挑 night_safe=true）"
echo "  · progress.md        —— 上一轮做到哪、有哪些验收债"
echo "铁律：一次只做一个任务；没 evidence 不准标 passing/done；夜间不碰正式站/.env/数据库/SSH。"
echo "=================================================="
echo " 自检完成。"
