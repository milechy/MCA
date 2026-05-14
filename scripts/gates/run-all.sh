#!/usr/bin/env bash
set -uo pipefail
# Note: removed -e so we can capture the failed gate's name before exiting,
# rather than the previous behaviour of bailing out at the first error and
# leaving the autonomous loop with failed_gate=null.

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

run_gate() {
  local name="$1"
  shift
  echo "[gate] start: $name"
  if ! "$@"; then
    # Phase 1 #7 fix: emit a structured FAILED_GATE line so gate-runner can
    # parse the name and surface it on the autonomous-loop's failure summary.
    echo "[gate] FAILED_GATE=$name"
    echo "[gate] failed: $name"
    exit 1
  fi
  echo "[gate] passed: $name"
}

run_gate "pre-secret-scan" bash scripts/gates/secret-scan.sh
run_gate "ralph-tests" bash scripts/gates/ralph-tests.sh
run_gate "telegram-tests" bash scripts/gates/telegram-tests.sh
run_gate "supabase-local" bash scripts/gates/supabase-local.sh
run_gate "playwright-e2e" bash scripts/gates/playwright-e2e.sh
run_gate "post-secret-scan" bash scripts/gates/secret-scan.sh

echo "[gate] all Phase 2 local gates passed"
