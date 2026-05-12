#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

echo "[ralph-issue-to-pr-smoke] running deterministic fixture smoke"
npm run ralph:issue-to-pr-smoke

echo "[ralph-issue-to-pr-smoke] passed"
