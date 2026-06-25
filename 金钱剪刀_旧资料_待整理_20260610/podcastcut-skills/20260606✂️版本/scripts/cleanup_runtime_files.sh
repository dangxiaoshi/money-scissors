#!/usr/bin/env sh
set -eu

APP_DIR="${MONEY_SCISSORS_APP_DIR:-/opt/money-scissors-m2}"
UPLOAD_DIR="${MONEY_SCISSORS_UPLOAD_DIR:-$APP_DIR/public/uploads}"
REFINE_DIR="${MONEY_SCISSORS_REFINE_DIR:-$APP_DIR/data/refine-jobs}"
UPLOAD_DAYS="${MONEY_SCISSORS_UPLOAD_RETENTION_DAYS:-3}"
REFINE_MINUTES="${MONEY_SCISSORS_REFINE_RETENTION_MINUTES:-180}"

if [ -d "$UPLOAD_DIR" ]; then
  find "$UPLOAD_DIR" -type f -mtime "+$UPLOAD_DAYS" -print -delete
  find "$UPLOAD_DIR" -type d -empty -print -delete
fi

if [ -d "$REFINE_DIR" ]; then
  find "$REFINE_DIR" -type f -mmin "+$REFINE_MINUTES" -print -delete
  find "$REFINE_DIR" -type d -empty -print -delete
fi
