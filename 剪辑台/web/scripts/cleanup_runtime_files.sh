#!/usr/bin/env sh
set -eu

APP_DIR="${MONEY_SCISSORS_APP_DIR:-/opt/money-scissors-m2}"
UPLOAD_DIR="${MONEY_SCISSORS_UPLOAD_DIR:-$APP_DIR/uploads}"
LEGACY_UPLOAD_DIR="${MONEY_SCISSORS_LEGACY_UPLOAD_DIR:-$APP_DIR/public/uploads}"
REFINE_DIR="${MONEY_SCISSORS_REFINE_DIR:-$APP_DIR/data/refine-jobs}"
CUT_JOBS_DIR="${MONEY_SCISSORS_CUT_JOBS_DIR:-$APP_DIR/data/cut-jobs}"
UPLOAD_DAYS="${MONEY_SCISSORS_UPLOAD_RETENTION_DAYS:-3}"
REFINE_MINUTES="${MONEY_SCISSORS_REFINE_RETENTION_MINUTES:-180}"
CUT_JOB_MINUTES="${MONEY_SCISSORS_CUT_JOB_RETENTION_MINUTES:-180}"
UPLOAD_CLEAN_MODE="${MONEY_SCISSORS_UPLOAD_CLEAN_MODE:-dry-run}"
DRY_RUN="${MONEY_SCISSORS_CLEANUP_DRY_RUN:-0}"

case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
esac

delete_old_files() {
  dir="$1"
  minutes="$2"
  label="$3"

  if [ ! -d "$dir" ]; then
    echo "skip $label: $dir not found"
    return
  fi

  if [ "$DRY_RUN" = "1" ]; then
    find "$dir" -type f -mmin "+$minutes" -print | sed "s#^#[dry-run] delete $label file #"
    find "$dir" -mindepth 1 -type d -empty -print | sed "s#^#[dry-run] delete empty $label dir #"
    return
  fi

  find "$dir" -type f -mmin "+$minutes" -print -delete
  find "$dir" -mindepth 1 -type d -empty -print -delete
}

delete_old_cut_job_files() {
  dir="$1"
  minutes="$2"

  if [ ! -d "$dir" ]; then
    echo "skip cut-job: $dir not found"
    return
  fi

  if [ "$DRY_RUN" = "1" ]; then
    find "$dir" -type f ! -path "$dir/state/*" -mmin "+$minutes" -print \
      | sed "s#^#[dry-run] delete cut-job file #"
    return
  fi

  find "$dir" -type f ! -path "$dir/state/*" -mmin "+$minutes" -print -delete
}

report_old_uploads() {
  dir="$1"
  label="$2"

  if [ ! -d "$dir" ]; then
    echo "skip $label: $dir not found"
    return
  fi

  if [ "$UPLOAD_CLEAN_MODE" = "delete" ] && [ "$DRY_RUN" != "1" ]; then
    find "$dir" -type f -mtime "+$UPLOAD_DAYS" -print -delete
    find "$dir" -mindepth 1 -type d -empty -print -delete
    return
  fi

  find "$dir" -type f -mtime "+$UPLOAD_DAYS" -print | sed "s#^#[upload dry-run] old $label file #"
  find "$dir" -mindepth 1 -type d -empty -print | sed "s#^#[upload dry-run] empty $label dir #"
}

report_old_uploads "$UPLOAD_DIR" "uploads"

if [ "$LEGACY_UPLOAD_DIR" != "$UPLOAD_DIR" ]; then
  report_old_uploads "$LEGACY_UPLOAD_DIR" "legacy uploads"
fi

delete_old_files "$REFINE_DIR" "$REFINE_MINUTES" "refine"
delete_old_cut_job_files "$CUT_JOBS_DIR" "$CUT_JOB_MINUTES"
