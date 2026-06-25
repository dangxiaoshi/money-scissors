#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BASE_URL="${MONEY_SCISSORS_BASE_URL:-https://chuanjiabao.vip}"
CUTOVER="${MONEY_SCISSORS_CUTOVER:-0}"

echo "Step 1/5: release check"
sh "$ROOT/scripts/check_release.sh"

echo "Step 2/5: production preflight"
sh "$ROOT/scripts/preflight_ecs.sh"

echo "Step 3/5: deploy to ECS"
sh "$ROOT/scripts/deploy_ecs.sh"

echo "Step 4/5: route check"
sh "$ROOT/scripts/check_remote_routing.sh"

if [ "$CUTOVER" = "1" ]; then
  echo "Step 5/5: cut over Nginx and smoke test $BASE_URL"
  sh "$ROOT/scripts/switch_nginx_to_money_scissors.sh"
  sh "$ROOT/scripts/check_remote_routing.sh"
  sh "$ROOT/scripts/smoke_test.sh" "$BASE_URL"
else
  echo "Step 5/5: cutover skipped"
  echo "Set MONEY_SCISSORS_CUTOVER=1 to switch Nginx to money-scissors and smoke test $BASE_URL."
fi

echo "Launch sequence finished"
