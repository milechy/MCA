#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

if ! command -v supabase >/dev/null 2>&1; then
  echo "[supabase-local] Supabase CLI is not installed"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[supabase-local] Docker CLI is not installed or not on PATH"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[supabase-local] Docker daemon is not running"
  exit 1
fi

echo "[supabase-local] checking local Supabase status"
supabase status >/tmp/ralph-supabase-status.txt 2>&1 || {
  echo "[supabase-local] supabase status failed"
  cat /tmp/ralph-supabase-status.txt
  rm -f /tmp/ralph-supabase-status.txt
  exit 1
}
rm -f /tmp/ralph-supabase-status.txt

echo "[supabase-local] running supabase db reset"
supabase db reset

echo "[supabase-local] passed"
