#!/usr/bin/env bash
set -euo pipefail

# Read file paths from stdin (one per line), ignore blank lines and lines
# starting with '#', and emit the corresponding gate names.

ralph=""
telegram=""
supabase=""
playwright=""

while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip blank lines and comments
  [[ -z "$line" ]] && continue
  [[ "$line" == \#* ]] && continue

  if [[ "$line" == src/ralph/* || "$line" == tests/ralph/* ]]; then
    ralph=1
  elif [[ "$line" == src/telegram/* || "$line" == tests/telegram/* ]]; then
    telegram=1
  elif [[ "$line" == supabase/migrations/* ]]; then
    supabase=1
  elif [[ "$line" == tests/e2e/* ]]; then
    playwright=1
  fi
done

# Deterministic output order: pre-secret-scan, then sorted suite gates, then post-secret-scan
echo "pre-secret-scan"
[[ -n "$ralph" ]] && echo "ralph-tests"
[[ -n "$telegram" ]] && echo "telegram-tests"
[[ -n "$supabase" ]] && echo "supabase-local"
[[ -n "$playwright" ]] && echo "playwright-e2e"
echo "post-secret-scan"
