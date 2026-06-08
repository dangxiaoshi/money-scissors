#!/usr/bin/env sh
set -eu

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"

ssh -i "$KEY" "$HOST" '
  set -eu
  echo "Listening ports:"
  ss -ltnp | grep -E ":(3000|3001|3002|8080|80|443) " || true
  echo
  echo "Nginx proxy targets:"
  grep -R -nE "server_name|proxy_pass|client_max_body_size" /etc/nginx/sites-enabled /etc/nginx/sites-available 2>/dev/null || true
  echo
  echo "Local endpoint checks:"
  for port in 3000 3001 3002; do
    printf ":%s /login -> " "$port"
    curl -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$port/login" || true
    printf ":%s /api/health -> " "$port"
    curl -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$port/api/health" || true
  done
'
