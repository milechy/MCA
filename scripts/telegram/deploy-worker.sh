#!/usr/bin/env bash
# Phase 15 #2: guided deploy of the Telegram NL/refinement Cloudflare Worker.
#
# Run this YOURSELF. It walks the wrangler steps in order. Secret values are
# entered into wrangler's own prompts (they never leave your machine / reach
# the assistant). KV namespace is already created (id in wrangler.toml).
#
# Prereqs: node/npx, a Cloudflare account, the values for the 6 secrets.
#
# Usage:
#   bash scripts/telegram/deploy-worker.sh

set -euo pipefail
cd "$(dirname "$0")/../../telegram-worker"

echo "=== 1/4  Cloudflare login ==="
if npx wrangler whoami 2>/dev/null | grep -qi 'logged in\|account'; then
  echo "✓ already logged in"
else
  npx wrangler login
fi

echo ""
echo "=== 2/4  set Worker secrets (you'll be prompted to paste each) ==="
SECRETS=(TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET ALLOWED_CHAT_ID GITHUB_PAT GITHUB_REPO OPENROUTER_API_KEY)
echo "Tip: TELEGRAM_WEBHOOK_SECRET = any random string you invent (reused in step 4)."
echo "     GITHUB_REPO = e.g. milechy/MCA    ALLOWED_CHAT_ID = your numeric chat id."
for s in "${SECRETS[@]}"; do
  read -r -p "set $s now? [Y/n] " yn; yn="${yn:-Y}"
  if [[ "$yn" =~ ^[Yy] ]]; then npx wrangler secret put "$s"; else echo "  skipped $s (set later with: npx wrangler secret put $s)"; fi
done

echo ""
echo "=== 3/4  deploy ==="
DEPLOY_OUT=$(npx wrangler deploy 2>&1 | tee /dev/tty)
WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1 || true)
[ -n "$WORKER_URL" ] && echo "✓ deployed: $WORKER_URL" || echo "⚠ couldn't auto-detect the Worker URL — copy it from the output above."

echo ""
echo "=== 4/4  point Telegram's webhook at the Worker ==="
echo "Run this (fill the token + the SAME webhook secret you set in step 2):"
echo ""
echo "  curl \"https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook\" \\"
echo "    -d url=${WORKER_URL:-<worker-url>} \\"
echo "    -d secret_token=<TELEGRAM_WEBHOOK_SECRET>"
echo ""
read -r -p "paste your bot token to set the webhook now (or leave blank to do it manually): " TOK
if [ -n "$TOK" ] && [ -n "${WORKER_URL:-}" ]; then
  read -r -s -p "webhook secret (same as step 2): " WS; echo
  curl -fsS "https://api.telegram.org/bot${TOK}/setWebhook" -d url="$WORKER_URL" -d secret_token="$WS" \
    && echo "" && echo "✓ webhook set. Text the bot a requirements doc to try the full loop." \
    || echo "⚠ setWebhook failed — run the curl above manually."
fi
echo ""
echo "Done. (Secrets entered into wrangler/curl prompts; nothing left your shell.)"
