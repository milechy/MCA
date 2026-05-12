#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

run_gate() {
  local name="$1"
  shift
  echo "[gate] start: $name"
  "$@"
  echo "[gate] passed: $name"
}

run_gate "pre-secret-scan" bash scripts/gates/secret-scan.sh
run_gate "ralph-tests" bash scripts/gates/ralph-tests.sh
run_gate "ralph-issue-to-pr-smoke" bash scripts/gates/ralph-issue-to-pr-smoke.sh
run_gate "telegram-tests" bash scripts/gates/telegram-tests.sh
run_gate "supabase-local" bash scripts/gates/supabase-local.sh
run_gate "playwright-e2e" bash scripts/gates/playwright-e2e.sh
run_gate "post-secret-scan" bash scripts/gates/secret-scan.sh

echo "[gate] all Phase 2 local gates passed"
