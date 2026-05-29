#!/usr/bin/env bash
# Phase 13 #3: one-shot setup for Telegram → GitHub Actions notifications.
#
# Run this YOURSELF (the bot token stays in your shell; it never leaves your
# machine). It:
#   1. verifies the bot token (getMe)
#   2. discovers your chat id (getUpdates) — message the bot first if empty
#   3. sets the two GitHub repo secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
#   4. sends a test message so you can confirm it works
#
# Prereqs: gh (authed), curl, jq.
#
# Usage:
#   bash scripts/telegram/setup-notifications.sh            # prompts for repo
#   REPO=milechy/MCA bash scripts/telegram/setup-notifications.sh

set -euo pipefail

REPO="${REPO:-}"
if [ -z "$REPO" ]; then read -r -p "GitHub repo (owner/name) [milechy/MCA]: " REPO; REPO="${REPO:-milechy/MCA}"; fi

for c in gh curl jq; do command -v "$c" >/dev/null || { echo "✘ need '$c' installed"; exit 1; }; done

# token: prompt without echoing
read -r -s -p "Telegram bot token (from @BotFather): " TG_TOKEN; echo
[ -n "$TG_TOKEN" ] || { echo "✘ empty token"; exit 1; }

echo "→ verifying token (getMe) ..."
ME=$(curl -fsS "https://api.telegram.org/bot${TG_TOKEN}/getMe") || { echo "✘ token rejected by Telegram"; exit 1; }
echo "$ME" | jq -e '.ok' >/dev/null || { echo "✘ getMe not ok: $ME"; exit 1; }
echo "✓ bot: @$(echo "$ME" | jq -r '.result.username')"

echo "→ discovering chat id (getUpdates) ..."
UPD=$(curl -fsS "https://api.telegram.org/bot${TG_TOKEN}/getUpdates")
mapfile -t CHATS < <(echo "$UPD" | jq -r '.result[]?.message.chat | "\(.id)\t\(.title // (.first_name + " " + (.last_name // "")) // .username // "?")"' | sort -u)
if [ "${#CHATS[@]}" -eq 0 ]; then
  echo "✘ no recent messages. Open Telegram, send any message to @$(echo "$ME" | jq -r '.result.username'), then re-run."
  exit 1
fi
echo "recent chats:"
i=1; for c in "${CHATS[@]}"; do echo "  [$i] $c"; i=$((i+1)); done
if [ "${#CHATS[@]}" -eq 1 ]; then
  CHAT_ID=$(echo "${CHATS[0]}" | cut -f1); echo "→ using the only chat: $CHAT_ID"
else
  read -r -p "pick chat number: " n; CHAT_ID=$(echo "${CHATS[$((n-1))]}" | cut -f1)
fi
[ -n "$CHAT_ID" ] || { echo "✘ no chat id"; exit 1; }

echo "→ setting GitHub secrets on $REPO ..."
printf '%s' "$TG_TOKEN" | gh secret set TELEGRAM_BOT_TOKEN --repo "$REPO"
printf '%s' "$CHAT_ID"  | gh secret set TELEGRAM_CHAT_ID  --repo "$REPO"
echo "✓ secrets set"

echo "→ sending test message ..."
curl -fsS "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  -d chat_id="$CHAT_ID" \
  --data-urlencode "text=✅ Ralph notifications wired. You'll get messages on PR merge, cost ceiling, and backlog events." >/dev/null \
  && echo "✓ test message sent — check Telegram." || echo "⚠ test send failed (secrets are still set)."

echo ""
echo "Done. GitHub Actions will now notify this chat. (Bot token never left your shell.)"
