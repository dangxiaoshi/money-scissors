#!/usr/bin/env sh
set -eu

# 金钱剪刀磁盘 H2 只读体检
#
# 用途：
#   sh scripts/audit_storage_h2.sh
#
# 安全边界：
# - 只读取 uploads / data / releases / .env 的状态
# - 不删除、不移动、不改数据库、不打印密钥值

HOST="${MONEY_SCISSORS_HOST:-root@8.136.133.196}"
KEY="${MONEY_SCISSORS_SSH_KEY:-$HOME/.ssh/money_scissors_ecs}"
APP_DIR="${MONEY_SCISSORS_APP_DIR:-/opt/money-scissors-m2}"
PROD_RELEASES="${MONEY_SCISSORS_PROD_RELEASES:-/opt/money-scissors-m2.releases}"
TEST_RELEASES="${MONEY_SCISSORS_TEST_RELEASES:-/opt/money-scissors-test.releases}"
UPLOAD_RETENTION_DAYS="${MONEY_SCISSORS_UPLOAD_RETENTION_DAYS:-30}"

ssh -i "$KEY" "$HOST" \
  "APP_DIR='$APP_DIR' PROD_RELEASES='$PROD_RELEASES' TEST_RELEASES='$TEST_RELEASES' UPLOAD_RETENTION_DAYS='$UPLOAD_RETENTION_DAYS' python3 - <<'PY'
import os
import re
import sqlite3
import time
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote, urlparse

app_dir = Path(os.environ['APP_DIR'])
upload_roots = [
    ('uploads', app_dir / 'uploads'),
    ('legacy_uploads', app_dir / 'public' / 'uploads'),
]
data_root = app_dir / 'data'
db_path = data_root / 'users.db'
template_root = data_root / 'practice-templates'
release_dirs = [
    ('prod', Path(os.environ['PROD_RELEASES'])),
    ('test', Path(os.environ['TEST_RELEASES'])),
]
retention_days = int(os.environ['UPLOAD_RETENTION_DAYS'])
now = time.time()

url_upload_re = re.compile(r'(?:https?://[^\\s\"\\'<>]+)?(/uploads/[^\\s\"\\'<>\\)\\]\\}]+)')
key_upload_re = re.compile(r'(?<![A-Za-z0-9_/-])(uploads/[^\\s\"\\'<>\\)\\]\\}]+)')
auto_backup_re = re.compile(r'^backup-\\d{8}-\\d{6}\\.tgz$')

def fmt_size(size):
    units = ['B', 'KB', 'MB', 'GB', 'TB']
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f'{value:.1f}{unit}' if unit != 'B' else f'{int(value)}B'
        value /= 1024

def short_list(items, limit=20):
    return items[:limit]

def normalize_upload_ref(value):
    value = str(value).strip()
    if not value:
        return ''
    if value.startswith('http://') or value.startswith('https://'):
        try:
            value = urlparse(value).path
        except Exception:
            return ''
    if value.startswith('uploads/'):
        value = '/' + value
    if not value.startswith('/uploads/'):
        return ''
    value = value.split('?', 1)[0].split('#', 1)[0]
    value = value.rstrip('.,;，。')
    return unquote(value)

def extract_upload_refs(text):
    if not text:
        return []
    found = set()
    candidates = [str(text)]
    decoded = unquote(str(text))
    if decoded != candidates[0]:
        candidates.append(decoded)
    for candidate in candidates:
        for match in url_upload_re.finditer(candidate):
            ref = normalize_upload_ref(match.group(1))
            if ref:
                found.add(ref)
        for match in key_upload_re.finditer(candidate):
            ref = normalize_upload_ref(match.group(1))
            if ref:
                found.add(ref)
    return sorted(found)

def upload_public_path(root, file_path):
    rel = file_path.relative_to(root).as_posix()
    return '/uploads/' + rel

def read_text(path):
    try:
        return path.read_text('utf-8', errors='ignore')
    except Exception:
        return ''

print('== H2 storage audit ==')
print(f'app_dir={app_dir}')
print(f'upload_retention_days={retention_days}')
print('')

upload_files = []
for label, root in upload_roots:
    if not root.exists():
        continue
    for file_path in root.rglob('*'):
        if not file_path.is_file():
            continue
        stat = file_path.stat()
        rel = upload_public_path(root, file_path)
        parts = rel.split('/')
        group = parts[2] if len(parts) > 2 else '(root)'
        upload_files.append({
            'label': label,
            'path': file_path,
            'rel': rel,
            'group': group,
            'name': file_path.name,
            'size': stat.st_size,
            'mtime': stat.st_mtime,
            'age_days': (now - stat.st_mtime) / 86400,
        })

total_upload_size = sum(row['size'] for row in upload_files)
print('== uploads summary ==')
print(f'files={len(upload_files)} size={fmt_size(total_upload_size)}')
by_group = defaultdict(lambda: {'count': 0, 'size': 0})
for row in upload_files:
    by_group[row['group']]['count'] += 1
    by_group[row['group']]['size'] += row['size']
for group, stat in sorted(by_group.items()):
    print(f'group {group} files={stat[\"count\"]} size={fmt_size(stat[\"size\"])}')
print('')

print('== uploads top files ==')
for row in sorted(upload_files, key=lambda item: item['size'], reverse=True)[:20]:
    day = time.strftime('%Y-%m-%d', time.localtime(row['mtime']))
    print(f'{fmt_size(row[\"size\"])} age={row[\"age_days\"]:.1f}d mtime={day} {row[\"rel\"]}')
print('')

template_refs = defaultdict(list)
if template_root.exists():
    for file_path in template_root.rglob('*'):
        if not file_path.is_file():
            continue
        for ref in extract_upload_refs(read_text(file_path)):
            template_refs[ref].append(str(file_path.relative_to(data_root)))

db_refs = defaultdict(list)
oss_object_refs = set()
if db_path.exists():
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    table_rows = conn.execute(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").fetchall()
    for table_row in table_rows:
        table = table_row['name']
        if table.startswith('sqlite_'):
            continue
        columns = conn.execute(f'PRAGMA table_info({table})').fetchall()
        text_columns = [row['name'] for row in columns if 'TEXT' in str(row['type']).upper() or row['type'] == '']
        if not text_columns:
            continue
        selected = ', '.join([f'\"{col}\"' for col in text_columns])
        try:
            rows = conn.execute(f'SELECT rowid AS __rowid, {selected} FROM \"{table}\"').fetchall()
        except Exception:
            continue
        for row in rows:
            rowid = row['__rowid']
            for col in text_columns:
                value = row[col]
                if not value:
                    continue
                for ref in extract_upload_refs(value):
                    source = f'{table}.{col}#{rowid}'
                    if len(db_refs[ref]) < 5:
                        db_refs[ref].append(source)
                    if table == 'oss_uploads' and '/uploads/' in ('/' + str(value)):
                        suffix = str(value).split('/uploads/', 1)[1]
                        oss_object_refs.add('/uploads/' + suffix)
    conn.close()

all_refs = set(template_refs) | set(db_refs)
file_paths = {row['rel']: row for row in upload_files}
oss_backed_refs = sorted(ref for ref in all_refs if ref not in file_paths and ref in oss_object_refs)
missing_refs = sorted(ref for ref in all_refs if ref not in file_paths and ref not in oss_object_refs)

print('== upload references ==')
print(f'template_ref_paths={len(template_refs)} db_ref_paths={len(db_refs)} oss_object_paths={len(oss_object_refs)} total_ref_paths={len(all_refs)}')
print(f'oss_backed_reference_paths={len(oss_backed_refs)}')
print(f'missing_local_referenced_files={len(missing_refs)}')
for ref in short_list(oss_backed_refs, 10):
    print(f'OSS_BACKED_REF {ref}')
for ref in short_list(missing_refs, 20):
    sources = []
    sources.extend(template_refs.get(ref, []))
    sources.extend(db_refs.get(ref, []))
    source_text = ','.join(sources[:5]) if sources else '(unknown)'
    print(f'MISSING_REF {ref} sources={source_text}')
print('')

fixed_keep = []
referenced_keep = []
recent_unreferenced = []
archive_candidates = []
small_anomalies = []
merged_unreferenced = []
for row in upload_files:
    rel = row['rel']
    is_practice = rel.startswith('/uploads/practice/')
    is_dispatch = row['name'].startswith('dispatch-')
    has_template_ref = rel in template_refs
    has_db_ref = rel in db_refs
    has_ref = has_template_ref or has_db_ref
    if is_practice or is_dispatch or has_template_ref:
        fixed_keep.append(row)
    elif has_db_ref:
        referenced_keep.append(row)
    elif row['age_days'] <= retention_days:
        recent_unreferenced.append(row)
    else:
        archive_candidates.append(row)
    if row['size'] < 1024 and not has_ref:
        small_anomalies.append(row)
    if row['name'].endswith('_merged.mp3') and not has_ref:
        merged_unreferenced.append(row)

def bucket_line(name, rows):
    print(f'{name} files={len(rows)} size={fmt_size(sum(row[\"size\"] for row in rows))}')

print('== upload buckets ==')
bucket_line('fixed_keep', fixed_keep)
bucket_line('referenced_keep', referenced_keep)
bucket_line('recent_unreferenced', recent_unreferenced)
bucket_line('archive_candidates_old_unreferenced', archive_candidates)
bucket_line('small_anomalies_unreferenced', small_anomalies)
bucket_line('merged_unreferenced', merged_unreferenced)
print('')

print('== archive candidates top ==')
for row in sorted(archive_candidates, key=lambda item: item['size'], reverse=True)[:30]:
    print(f'ARCHIVE_CANDIDATE {fmt_size(row[\"size\"])} age={row[\"age_days\"]:.1f}d {row[\"rel\"]}')
print('')

print('== small anomalies ==')
for row in sorted(small_anomalies, key=lambda item: (item['size'], item['rel']))[:30]:
    print(f'SMALL_ANOMALY {fmt_size(row[\"size\"])} age={row[\"age_days\"]:.1f}d {row[\"rel\"]}')
print('')

print('== merged unreferenced ==')
for row in sorted(merged_unreferenced, key=lambda item: item['size'], reverse=True)[:20]:
    print(f'MERGED_UNREFERENCED {fmt_size(row[\"size\"])} age={row[\"age_days\"]:.1f}d {row[\"rel\"]}')
print('')

print('== release confirmation list ==')
for label, root in release_dirs:
    if not root.exists():
        print(f'{label} missing {root}')
        continue
    buckets = defaultdict(list)
    for file_path in root.iterdir():
        if not file_path.is_file():
            continue
        stat = file_path.stat()
        name = file_path.name
        if auto_backup_re.match(name):
            kind = 'auto'
        elif name.startswith('manual-'):
            kind = 'manual_confirm'
        elif name.startswith('backup-before-') or name.startswith('server-before-') or name.endswith('.bak') or name == '.tgz':
            kind = 'legacy_confirm'
        else:
            kind = 'other_confirm'
        buckets[kind].append({
            'name': name,
            'path': file_path,
            'size': stat.st_size,
            'mtime': stat.st_mtime,
            'age_days': (now - stat.st_mtime) / 86400,
        })
    print(f'[{label}] root={root}')
    for kind in ['auto', 'manual_confirm', 'legacy_confirm', 'other_confirm']:
        rows = buckets[kind]
        print(f'{kind} files={len(rows)} size={fmt_size(sum(row[\"size\"] for row in rows))}')
    confirm_rows = buckets['manual_confirm'] + buckets['legacy_confirm'] + buckets['other_confirm']
    for row in sorted(confirm_rows, key=lambda item: item['size'], reverse=True)[:20]:
        print(f'CONFIRM {label} {fmt_size(row[\"size\"])} age={row[\"age_days\"]:.1f}d {row[\"name\"]}')
print('')

print('== oss readiness ==')
env_path = app_dir / '.env'
keys = {}
if env_path.exists():
    for line in read_text(env_path).splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        keys[key.strip()] = value.strip()
required = ['STORAGE_BACKEND', 'OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET']
for key in required:
    if key == 'STORAGE_BACKEND':
        print(f'{key}={keys.get(key, \"(missing)\") or \"(empty)\"}')
    else:
        state = 'present' if keys.get(key) else 'missing'
        print(f'{key}={state}')
print('')

print('== suggested next action ==')
if archive_candidates:
    print(f'Need manual H3 archive/delete decision for {len(archive_candidates)} old unreferenced uploads, size={fmt_size(sum(row[\"size\"] for row in archive_candidates))}.')
else:
    print(f'No uploads older than {retention_days} days are safe archive candidates yet.')
if small_anomalies:
    print(f'Review {len(small_anomalies)} tiny unreferenced upload files before deletion.')
if any(keys.get(key) in (None, '') for key in required[1:]) or keys.get('STORAGE_BACKEND') != 'oss':
    print('OSS is not fully enabled; configure OSS env and run upload/export regression before switching new uploads off ECS disk.')
else:
    print('OSS env appears present; run upload/export regression before enabling as default if not already live.')
PY"
