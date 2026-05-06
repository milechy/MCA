#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

TARGETS=(
  "src"
  "scripts"
  "policies"
  "docs"
  "tests"
  "supabase/config.toml"
  "package.json"
  "package-lock.json"
)

PATTERNS=(
  'service_role[[:space:]_-]*key[[:space:]]*[:=][[:space:]]*[A-Za-z0-9._-]+'
  'SUPABASE_SERVICE_ROLE_KEY[[:space:]]*[:=][[:space:]]*[A-Za-z0-9._-]+'
  'sk-[A-Za-z0-9_-]{20,}'
  'AIza[0-9A-Za-z_-]{20,}'
  'xox[baprs]-[0-9A-Za-z-]{10,}'
  'ghp_[0-9A-Za-z]{20,}'
  'github_pat_[0-9A-Za-z_]{20,}'
  'TELEGRAM_BOT_TOKEN[[:space:]]*[:=][[:space:]]*[0-9]+:[A-Za-z0-9_-]+'
)

found=0
for target in "${TARGETS[@]}"; do
  [[ -e "$target" ]] || continue
  for pattern in "${PATTERNS[@]}"; do
    if grep -RInE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=playwright-report --exclude-dir=test-results "$pattern" "$target" >/tmp/ralph-secret-scan-matches.txt 2>/dev/null; then
      echo "[secret-scan] potential secret detected in target: $target"
      cat /tmp/ralph-secret-scan-matches.txt
      found=1
    fi
  done
done

rm -f /tmp/ralph-secret-scan-matches.txt

if [[ "$found" -ne 0 ]]; then
  echo "[secret-scan] failed"
  exit 1
fi

echo "[secret-scan] passed"
