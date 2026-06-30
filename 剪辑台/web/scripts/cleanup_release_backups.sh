#!/usr/bin/env sh
set -eu

# 清理金钱剪刀自动发布备份（H1）
#
# 默认只预演，不删除：
#   sh scripts/cleanup_release_backups.sh
#
# 真正删除必须显式确认：
#   sh scripts/cleanup_release_backups.sh --apply
#
# 安全边界：
# - 只处理 release 目录里的 backup-YYYYMMDD-HHMMSS.tgz
# - 不处理 manual-* 手动备份
# - 不处理 uploads / data / private / 数据库

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
PROD_RELEASES="${MONEY_SCISSORS_PROD_RELEASES:-/opt/money-scissors-m2.releases}"
TEST_RELEASES="${MONEY_SCISSORS_TEST_RELEASES:-/opt/money-scissors-test.releases}"
PROD_KEEP="${MONEY_SCISSORS_PROD_RELEASE_KEEP:-8}"
TEST_KEEP="${MONEY_SCISSORS_TEST_RELEASE_KEEP:-5}"
PROD_MIN_DAYS="${MONEY_SCISSORS_PROD_RELEASE_MIN_DAYS:-7}"
TEST_MIN_DAYS="${MONEY_SCISSORS_TEST_RELEASE_MIN_DAYS:-3}"
APPLY=0

case "${1:---dry-run}" in
  --dry-run) APPLY=0 ;;
  --apply) APPLY=1 ;;
  -h|--help)
    sed -n '1,18p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: sh scripts/cleanup_release_backups.sh [--dry-run|--apply]" >&2
    exit 1
    ;;
esac

ssh -i "$KEY" "$HOST" \
  "APPLY='$APPLY' PROD_RELEASES='$PROD_RELEASES' TEST_RELEASES='$TEST_RELEASES' PROD_KEEP='$PROD_KEEP' TEST_KEEP='$TEST_KEEP' PROD_MIN_DAYS='$PROD_MIN_DAYS' TEST_MIN_DAYS='$TEST_MIN_DAYS' python3 - <<'PY'
import os
import re
import time
from pathlib import Path

apply = os.environ.get('APPLY') == '1'
backup_name = re.compile(r'^backup-\d{8}-\d{6}\.tgz$')

targets = [
    ('prod', Path(os.environ['PROD_RELEASES']), int(os.environ['PROD_KEEP']), int(os.environ['PROD_MIN_DAYS'])),
    ('test', Path(os.environ['TEST_RELEASES']), int(os.environ['TEST_KEEP']), int(os.environ['TEST_MIN_DAYS'])),
]

now = time.time()
grand_total = 0
grand_count = 0

print('mode=' + ('apply' if apply else 'dry-run'))

for label, root, keep_count, min_days in targets:
    print('')
    print(f'[{label}] root={root} keep={keep_count} min_days={min_days}')
    if not root.exists():
        print('missing release dir, skipped')
        continue
    files = []
    for item in root.iterdir():
        if not item.is_file() or not backup_name.match(item.name):
            continue
        stat = item.stat()
        files.append({
            'path': item,
            'mtime': stat.st_mtime,
            'size': stat.st_size,
            'age_days': (now - stat.st_mtime) / 86400,
        })
    files.sort(key=lambda row: row['mtime'], reverse=True)

    delete = []
    keep = []
    for index, row in enumerate(files):
        if index < keep_count or row['age_days'] < min_days:
            keep.append(row)
        else:
            delete.append(row)

    delete_total = sum(row['size'] for row in delete)
    grand_total += delete_total
    grand_count += len(delete)
    print(f'auto_backups={len(files)} keep={len(keep)} delete={len(delete)} delete_size={delete_total / 1024 / 1024:.1f}MB')

    for row in delete:
        rel = row['path'].name
        print(f\"DELETE {label} {row['size'] / 1024 / 1024:.1f}MB age={row['age_days']:.1f}d {rel}\")

    if apply:
        for row in delete:
            target = row['path']
            if target.parent != root or not backup_name.match(target.name):
                raise RuntimeError(f'unsafe delete target: {target}')
            target.unlink()

print('')
print(f'total_delete_count={grand_count}')
print(f'total_delete_size={grand_total / 1024 / 1024:.1f}MB')
if not apply and grand_count:
    print('dry-run only; rerun with --apply to delete')
PY"
