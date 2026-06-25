#!/usr/bin/env sh
set -eu

APP_DIR="${MONEY_SCISSORS_APP_DIR:-/opt/money-scissors-m2}"
DB_PATH="${MONEY_SCISSORS_DB_PATH:-$APP_DIR/data/users.db}"
BACKUP_DIR="${MONEY_SCISSORS_BACKUP_DIR:-$APP_DIR/data/backups}"
KEEP="${MONEY_SCISSORS_BACKUP_KEEP:-7}"

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
backup="$BACKUP_DIR/users-$stamp.db.gz"

gzip -c "$DB_PATH" > "$backup"
echo "Created $backup"

find "$BACKUP_DIR" -name 'users-*.db.gz' -type f | sort -r | awk -v keep="$KEEP" 'NR > keep' | xargs -r rm -f
