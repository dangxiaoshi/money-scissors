#!/usr/bin/env sh
set -eu

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
SITE_NAME="${MONEY_SCISSORS_NGINX_SITE:-chuanjiabao}"
UPSTREAM="${MONEY_SCISSORS_UPSTREAM:-127.0.0.1:3002}"
BODY_SIZE="${MONEY_SCISSORS_CLIENT_MAX_BODY_SIZE:-500m}"

ssh -i "$KEY" "$HOST" "
  set -eu

  site_available='/etc/nginx/sites-available/$SITE_NAME'
  site_enabled='/etc/nginx/sites-enabled/$SITE_NAME'
  test -f \"\$site_available\"

  backup_dir='/etc/nginx/money-scissors-backups'
  mkdir -p \"\$backup_dir\"
  stamp=\$(date +%Y%m%d-%H%M%S)
  cp \"\$site_available\" \"\$backup_dir/$SITE_NAME-\$stamp.conf\"

  python3 - \"\$site_available\" '$UPSTREAM' '$BODY_SIZE' <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
upstream = sys.argv[2]
body_size = sys.argv[3]
text = path.read_text()

text, proxy_count = re.subn(
    r'proxy_pass\s+http://127\.0\.0\.1:\d+\s*;',
    f'proxy_pass http://{upstream};',
    text,
)
if proxy_count == 0:
    raise SystemExit('No localhost proxy_pass found to update.')

if re.search(r'client_max_body_size\s+\S+\s*;', text):
    text = re.sub(r'client_max_body_size\s+\S+\s*;', f'client_max_body_size {body_size};', text)
else:
    text = re.sub(
        r'(server\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*)',
        r'\1\n    client_max_body_size ' + body_size + ';',
        text,
        count=1,
        flags=re.S,
    )

path.write_text(text)
PY

  if [ -L \"\$site_enabled\" ] || [ -f \"\$site_enabled\" ]; then
    :
  else
    ln -s \"\$site_available\" \"\$site_enabled\"
  fi

  nginx -t
  systemctl reload nginx

  echo \"Updated \$site_available\"
  echo \"Backup: \$backup_dir/$SITE_NAME-\$stamp.conf\"
  grep -nE 'server_name|proxy_pass|client_max_body_size' \"\$site_available\"
"
