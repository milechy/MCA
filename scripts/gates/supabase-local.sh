#!/usr/bin/env bash
set -euo pipefail

# Phase 4 番外: supabase-local gate policy.
#
# Before this change, the gate was hard-required and would fail any run
# where Supabase CLI / Docker / the local Postgres container was not
# ready, including routine autonomous-loop runs that only modify JS/MD
# files and never touch the database. That made every Kimi dogfood land
# in gate_repair_escalated for environmental reasons unrelated to the
# patch (Phase 3 #5, Phase 4 #1, Phase 4 #2 all hit this).
#
# New default: soft-skip when prerequisites or the local stack are not
# ready. CI / migration PRs opt back in to the strict behavior via
# RALPH_REQUIRE_SUPABASE_GATE=1. Explicit skip is also available via
# RALPH_SKIP_SUPABASE_GATE=1 (overrides the require flag for break-glass
# situations).

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

REQUIRE_GATE="${RALPH_REQUIRE_SUPABASE_GATE:-0}"
SKIP_GATE="${RALPH_SKIP_SUPABASE_GATE:-0}"

skip_softly() {
  local reason="$1"
  echo "[supabase-local] SKIPPED ($reason). Set RALPH_REQUIRE_SUPABASE_GATE=1 to hard-fail on this condition."
  exit 0
}

fail_or_skip() {
  local reason="$1"
  if [ "$REQUIRE_GATE" = "1" ]; then
    echo "[supabase-local] $reason"
    exit 1
  fi
  skip_softly "$reason"
}

if [ "$SKIP_GATE" = "1" ]; then
  skip_softly "RALPH_SKIP_SUPABASE_GATE=1"
fi

if ! command -v supabase >/dev/null 2>&1; then
  fail_or_skip "Supabase CLI is not installed"
fi

if ! command -v docker >/dev/null 2>&1; then
  fail_or_skip "Docker CLI is not installed or not on PATH"
fi

if ! docker info >/dev/null 2>&1; then
  fail_or_skip "Docker daemon is not running"
fi

echo "[supabase-local] checking local Supabase status"
if ! supabase status >/tmp/ralph-supabase-status.txt 2>&1; then
  cat /tmp/ralph-supabase-status.txt
  rm -f /tmp/ralph-supabase-status.txt
  fail_or_skip "supabase status failed (local stack not reachable)"
fi
rm -f /tmp/ralph-supabase-status.txt

echo "[supabase-local] running supabase db reset"
supabase db reset

echo "[supabase-local] passed"
