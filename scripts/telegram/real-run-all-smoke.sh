#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPROVAL_JSON="${TMPDIR:-/tmp}/telegram-real-run-all-smoke-approval.json"

cleanup() {
  unset RALPH_TELEGRAM_RUN_ALL_ENABLED || true
  unset TELEGRAM_BOT_TOKEN || true
  unset TELEGRAM_ALLOWED_USER_IDS || true
  unset TELEGRAM_ALLOWED_CHAT_IDS || true
  git -C "$ROOT_DIR" restore .ralph/approval-log.jsonl 2>/dev/null || true
}
trap cleanup EXIT

cd "$ROOT_DIR"

echo "[real-run-all-smoke] This manual smoke will prompt for Telegram credentials without echoing the bot token."
echo "[real-run-all-smoke] Do not paste the token into chat or commit it to files."

printf "Telegram bot token: "
IFS= read -r -s TELEGRAM_BOT_TOKEN
echo
printf "Telegram allowed user id(s), comma-separated: "
IFS= read -r TELEGRAM_ALLOWED_USER_IDS
printf "Telegram allowed chat id(s), comma-separated: "
IFS= read -r TELEGRAM_ALLOWED_CHAT_IDS

export TELEGRAM_BOT_TOKEN
export TELEGRAM_ALLOWED_USER_IDS
export TELEGRAM_ALLOWED_CHAT_IDS
unset RALPH_TELEGRAM_RUN_ALL_ENABLED

node scripts/telegram/preflight-no-secrets.js >/tmp/telegram-real-run-all-smoke-preflight.json
node scripts/telegram/create-run-all-smoke-approval.js > "$APPROVAL_JSON"

APPROVAL_ID="$(node -p "require('$APPROVAL_JSON').approval_id")"
COMMAND_TO_SEND="$(node -p "require('$APPROVAL_JSON').command_to_send")"

if [[ -z "$APPROVAL_ID" || "$APPROVAL_ID" == "undefined" ]]; then
  echo "[real-run-all-smoke] ERROR: approval id is empty." >&2
  exit 1
fi

if [[ -z "$COMMAND_TO_SEND" || "$COMMAND_TO_SEND" == "undefined" ]]; then
  echo "[real-run-all-smoke] ERROR: command_to_send is empty." >&2
  exit 1
fi

echo
printf '%s\n' "[real-run-all-smoke] Fresh approval id: $APPROVAL_ID"
echo "[real-run-all-smoke] Send this exact one-line command to the Telegram bot:"
printf '%s\n' "$COMMAND_TO_SEND"
echo
read -r -p "[real-run-all-smoke] Press Enter after sending the command in Telegram... " _

export RALPH_TELEGRAM_RUN_ALL_ENABLED=true

echo "[real-run-all-smoke] Polling Telegram updates matched to approval id: $APPROVAL_ID"
node scripts/telegram/poll-update-smoke.js --match-command-substring="$APPROVAL_ID" --limit=100

echo "[real-run-all-smoke] Inspecting logs..."
node scripts/telegram/inspect-logs.js

echo "[real-run-all-smoke] git status after smoke cleanup will run on exit."
