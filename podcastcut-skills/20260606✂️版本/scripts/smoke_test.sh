#!/usr/bin/env sh
set -eu

BASE_URL="${1:-${MONEY_SCISSORS_BASE_URL:-http://8.136.133.196}}"

echo "Checking $BASE_URL/api/health"
curl -fsS "$BASE_URL/api/health" >/dev/null

echo "Checking $BASE_URL/login"
curl -fsSI "$BASE_URL/login" >/dev/null

echo "Checking security headers on $BASE_URL/login"
headers="$(curl -fsSI "$BASE_URL/login")"
printf '%s\n' "$headers" | grep -qi '^X-Content-Type-Options: nosniff' || {
  echo "Missing X-Content-Type-Options: nosniff" >&2
  exit 1
}
printf '%s\n' "$headers" | grep -qi '^Referrer-Policy:' || {
  echo "Missing Referrer-Policy" >&2
  exit 1
}
printf '%s\n' "$headers" | grep -qi '^X-Frame-Options:' || {
  echo "Missing X-Frame-Options" >&2
  exit 1
}

echo "Checking auth guard on $BASE_URL/api/auth/me"
status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/auth/me")"
if [ "$status" != "200" ]; then
  echo "Expected 200 for guest auth endpoint, got $status" >&2
  exit 1
fi

echo "Checking guest access on $BASE_URL/api/refine/status/test"
status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/refine/status/test")"
if [ "$status" != "404" ]; then
  echo "Expected 404 for missing refine job in guest mode, got $status" >&2
  exit 1
fi

echo "Checking guest access on $BASE_URL/api/deepseek/chat"
status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[]}' \
  "$BASE_URL/api/deepseek/chat")"
if [ "$status" != "400" ]; then
  echo "Expected 400 for missing DeepSeek messages in guest mode, got $status" >&2
  exit 1
fi

echo "Smoke test passed"
