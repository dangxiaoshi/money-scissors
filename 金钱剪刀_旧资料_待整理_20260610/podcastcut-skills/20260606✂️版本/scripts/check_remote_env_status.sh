#!/usr/bin/env sh
set -eu

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
REMOTE_DIR="${MONEY_SCISSORS_REMOTE_DIR:-/opt/money-scissors-m2}"

ssh -i "$KEY" "$HOST" "REMOTE_ENV_PATH='$REMOTE_DIR/.env' python3 - <<'PY'
import os
from pathlib import Path

required = [
    'PORT',
    'PUBLIC_BASE_URL',
    'DASHSCOPE_API_KEY',
    'DEEPSEEK_KEY',
]
placeholders = ('replace-with-', '__FILL_BEFORE_DEPLOY__', 'your-domain.example', 'test')

path = Path(os.environ['REMOTE_ENV_PATH'])
print(f'env_path={path}')
if not path.exists():
    print('env_file=missing')
    raise SystemExit(1)

mode = path.stat().st_mode & 0o777
print(f'env_permissions={mode:o}')

values = {}
for line in path.read_text().splitlines():
    if not line or line.lstrip().startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    values[key] = value

failed = False
for key in required:
    if key not in values:
        status = 'missing'
        failed = True
    elif values[key] == '':
        status = 'empty'
        failed = True
    elif values[key].startswith(placeholders) or values[key] in {'test', 'test-jwt-secret'}:
        status = 'placeholder'
        failed = True
    elif key == 'PUBLIC_BASE_URL' and not values[key].startswith('https://'):
        status = 'not_https'
        failed = True
    elif key == 'ALLOW_DEV_SEND_CODE_FALLBACK' and values[key] == '1':
        status = 'dev_fallback_enabled'
        failed = True
    else:
        status = 'ok'
    print(f'{key}={status}')

if mode not in (0o400, 0o600):
    print('env_permissions_status=too_open')
    failed = True
else:
    print('env_permissions_status=ok')

raise SystemExit(1 if failed else 0)
PY"
