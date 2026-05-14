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

raw_matches="$(mktemp -t ralph-secret-scan-matches.XXXXXX)"
filtered_matches="$(mktemp -t ralph-secret-scan-filtered.XXXXXX)"
trap 'rm -f "$raw_matches" "$filtered_matches"' EXIT

# Phase 1 #7 fix: filter out lines marked with a NOSCAN-FIXTURE annotation.
# Two annotation forms are supported, both narrowly scoped to the single line
# being skipped — there is no whole-file or directory-wide silencer:
#
#   1. The matching line itself contains // NOSCAN-FIXTURE  (or # NOSCAN-FIXTURE).
#   2. The line immediately above the match starts with // NOSCAN-FIXTURE: ...
#      (or # NOSCAN-FIXTURE: ...) and contains a short rationale.
#
# Both must be human-readable comments review can scrutinize. There is no
# silencer for a literal raw secret value; the annotation is for test fixtures
# and template strings that happen to share the secret regex.
filter_noscan_matches() {
  local in="$1"
  local out="$2"
  : > "$out"
  while IFS= read -r line || [[ -n "$line" ]]; do
    # grep -RIn output: file:line:content
    local file lineno content
    file="$(echo "$line" | awk -F: '{print $1}')"
    lineno="$(echo "$line" | awk -F: '{print $2}')"
    content="$(echo "$line" | cut -d: -f3-)"

    # Skip if the matched line itself carries an inline NOSCAN-FIXTURE marker.
    if echo "$content" | grep -qE '(//|#)[[:space:]]*NOSCAN-FIXTURE'; then
      continue
    fi

    # Skip if the immediately preceding line is a NOSCAN-FIXTURE annotation.
    if [[ "$lineno" =~ ^[0-9]+$ ]] && [[ "$lineno" -gt 1 ]] && [[ -f "$file" ]]; then
      local prev
      prev="$(sed -n "$((lineno - 1))p" "$file" 2>/dev/null || true)"
      if echo "$prev" | grep -qE '^[[:space:]]*(//|#)[[:space:]]*NOSCAN-FIXTURE([[:space:]]*:|$)'; then
        continue
      fi
    fi

    echo "$line" >> "$out"
  done < "$in"
}

found=0
for target in "${TARGETS[@]}"; do
  [[ -e "$target" ]] || continue
  for pattern in "${PATTERNS[@]}"; do
    if grep -RInE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=playwright-report --exclude-dir=test-results "$pattern" "$target" >"$raw_matches" 2>/dev/null; then
      filter_noscan_matches "$raw_matches" "$filtered_matches"
      if [[ -s "$filtered_matches" ]]; then
        echo "[secret-scan] potential secret detected in target: $target"
        cat "$filtered_matches"
        found=1
      fi
    fi
  done
done

if [[ "$found" -ne 0 ]]; then
  echo "[secret-scan] failed"
  exit 1
fi

echo "[secret-scan] passed"
