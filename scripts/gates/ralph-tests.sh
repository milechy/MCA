#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

echo "[ralph-tests] running npm run test:ralph"
npm run test:ralph

echo "[ralph-tests] passed"
