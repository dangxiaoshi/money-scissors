#!/usr/bin/env sh
set -eu

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
REMOTE_DIR="${MONEY_SCISSORS_REMOTE_DIR:-/opt/money-scissors-m2}"
MODE="${MONEY_SCISSORS_PREFLIGHT_MODE:-production}"

command -v ssh >/dev/null
command -v rsync >/dev/null
test -f "$KEY"

ssh -i "$KEY" "$HOST" "
  set -eu
  test -d '$REMOTE_DIR'
  test -f '$REMOTE_DIR/.env'
  if [ '$MODE' = 'production' ]; then
    env_perms=\$(stat -c %a '$REMOTE_DIR/.env')
    case \"\$env_perms\" in
      400|600) ;;
      *)
        echo \"Production preflight failed: $REMOTE_DIR/.env permissions must be 600 or 400, got \$env_perms\" >&2
        exit 1
        ;;
    esac
  fi

  required='PORT PUBLIC_BASE_URL DASHSCOPE_API_KEY DEEPSEEK_KEY'

  missing=''
  invalid=''
  for key in \$required; do
    line=\$(grep -m 1 \"^\$key=\" '$REMOTE_DIR/.env' || true)
    value=\${line#*=}
    if [ -z \"\$line\" ] || [ -z \"\$value\" ]; then
      missing=\"\$missing \$key\"
      continue
    fi
    case \"\$value\" in
      replace-with-*|__FILL_BEFORE_DEPLOY__|your-domain.example|test|test-*)
        invalid=\"\$invalid \$key\"
        ;;
    esac
    if [ '$MODE' = 'production' ] && [ \"\$key\" = 'PUBLIC_BASE_URL' ]; then
      case \"\$value\" in
        https://*) ;;
        *) invalid=\"\$invalid PUBLIC_BASE_URL_must_be_https\" ;;
      esac
    fi
  done
  if [ -n \"\$missing\" ]; then
    echo \"Missing required .env keys:\$missing\" >&2
    exit 1
  fi
  if [ -n \"\$invalid\" ]; then
    echo \"Invalid production .env values:\$invalid\" >&2
    exit 1
  fi

  if [ '$MODE' = 'production' ] && grep -q '^ALLOW_DEV_SEND_CODE_FALLBACK=1' '$REMOTE_DIR/.env'; then
    echo 'Production preflight failed: ALLOW_DEV_SEND_CODE_FALLBACK=1 must be disabled.' >&2
    exit 1
  fi

  command -v node >/dev/null
  command -v npm >/dev/null
  command -v pm2 >/dev/null
  command -v curl >/dev/null
  command -v python3 >/dev/null
  command -v ffmpeg >/dev/null
  command -v ffprobe >/dev/null
  if [ '$MODE' = 'production' ]; then
    command -v nginx >/dev/null
    command -v systemctl >/dev/null
  fi
  df -h '$REMOTE_DIR'
"
