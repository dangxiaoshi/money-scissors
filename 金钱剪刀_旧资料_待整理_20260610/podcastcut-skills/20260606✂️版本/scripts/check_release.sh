#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

npm --prefix "$ROOT" run check

find "$ROOT/js" "$ROOT/public/refine/js" -name '*.js' -type f | while IFS= read -r file; do
  node --check "$file"
done

if rg -n \
  -g '!node_modules/**' \
  -g '!package-lock.json' \
  -g '!PLAN_M2.md' \
  -g '!SPEC.md' \
  -g '!DEPLOY.md' \
  -g '!scripts/check_release.sh' \
  "sk-[A-Za-z0-9_-]{16,}|LTAI[0-9A-Za-z]{12,}|accessKeySecret: '|accessKeyId: '" \
  "$ROOT"; then
  echo "Release check failed: possible secret found in web release files." >&2
  exit 1
fi

echo "Release check passed"
