#!/usr/bin/env sh
set -eu

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
REMOTE_DIR="${MONEY_SCISSORS_REMOTE_DIR:-/opt/money-scissors-m2}"

if [ $# -eq 0 ]; then
  echo "Usage: DEEPSEEK_KEY=... sh scripts/set_remote_env.sh DEEPSEEK_KEY [PUBLIC_BASE_URL ...]" >&2
  exit 1
fi

payload=''
for name in "$@"; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "Missing local environment variable: $name" >&2
    exit 1
  fi
  payload="${payload}${name}=${value}
"
done

printf '%s' "$payload" | ssh -i "$KEY" "$HOST" "REMOTE_ENV_PATH='$REMOTE_DIR/.env' python3 -c '
import os
import sys
from pathlib import Path

env_path = Path(os.environ[\"REMOTE_ENV_PATH\"])
incoming = {}
for line in sys.stdin.read().splitlines():
    if not line or \"=\" not in line:
        continue
    key, value = line.split(\"=\", 1)
    incoming[key] = value

existing = {}
order = []
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if not line or line.lstrip().startswith(\"#\") or \"=\" not in line:
            continue
        key, value = line.split(\"=\", 1)
        existing[key] = value
        order.append(key)

for key, value in incoming.items():
    if key not in existing:
        order.append(key)
    existing[key] = value

env_path.parent.mkdir(parents=True, exist_ok=True)
env_path.write_text(\"\".join(f\"{key}={existing[key]}\\n\" for key in order))
print(\"Updated keys:\", \", \".join(incoming.keys()))
'
chmod 600 '$REMOTE_DIR/.env'
echo 'Remote .env permissions set to 600'
"
