#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

echo "[telegram-tests] running npm run test:telegram"
npm run test:telegram

echo "[telegram-tests] passed"
