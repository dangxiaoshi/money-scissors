#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEFAULT_NODE="/Users/dang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

# 语法检查：直接用 node，不依赖 npm（npm run check 本质就是 node --check server.cjs，
# 但在没装 npm 或 npm 慢/坏的环境里会整条检查跑不起来）。
if [ -n "${NODE_BIN:-}" ]; then
  NODE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [ -x "$DEFAULT_NODE" ]; then
  NODE="$DEFAULT_NODE"
else
  echo "Release check failed: node not found in PATH." >&2
  exit 1
fi

"$NODE" --check "$ROOT/server.cjs"

find "$ROOT/js" "$ROOT/public/refine/js" -name '*.js' -type f | while IFS= read -r file; do
  "$NODE" --check "$file"
done

# 密钥扫描：优先用 rg，没装 rg 时回退到 grep，保证任何环境都能跑检查。
SECRET_PATTERN="sk-[A-Za-z0-9_-]{16,}|LTAI[0-9A-Za-z]{12,}|accessKeySecret: '|accessKeyId: '"

if command -v rg >/dev/null 2>&1; then
  if rg -n \
    -g '!node_modules/**' \
    -g '!package-lock.json' \
    -g '!PLAN_M2.md' \
    -g '!SPEC.md' \
    -g '!DEPLOY.md' \
    -g '!scripts/check_release.sh' \
    -g '!**/scripts/check_release.sh' \
    "$SECRET_PATTERN" \
    "$ROOT"; then
    echo "Release check failed: possible secret found in web release files." >&2
    exit 1
  fi
else
  echo "rg not found, falling back to grep for secret scan." >&2
  if grep -rEn \
    --exclude-dir=node_modules \
    --exclude=package-lock.json \
    --exclude=PLAN_M2.md \
    --exclude=SPEC.md \
    --exclude=DEPLOY.md \
    --exclude=check_release.sh \
    "$SECRET_PATTERN" \
    "$ROOT"; then
    echo "Release check failed: possible secret found in web release files." >&2
    exit 1
  fi
fi

echo "Release check passed"
