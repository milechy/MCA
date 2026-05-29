#!/usr/bin/env node
// Phase 13 #1 CLI: send a Telegram notification (best-effort, no-op if unset).
//
// Usage:
//   node scripts/ralph/notify-telegram.js "your *markdown* message"
//   echo "message" | node scripts/ralph/notify-telegram.js
//
// Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from env. Exits 0 always
// (notifications must never fail a workflow). Prints what happened.

const { notify } = require('../../src/ralph/telegram-notify');

async function main(argv = process.argv.slice(2), { env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  let text = argv.join(' ').trim();
  if (!text && !stdin.isTTY) {
    text = await new Promise((resolve) => {
      let s = '';
      stdin.on('data', (d) => (s += d));
      stdin.on('end', () => resolve(s.trim()));
    });
  }
  if (!text) {
    stdout.write('notify-telegram: no message given — skipping\n');
    return { skipped: true, reason: 'no_message' };
  }
  const result = await notify({ env, text });
  if (result.skipped) stdout.write(`notify-telegram: skipped (${result.reason})\n`);
  else if (result.ok) stdout.write(`notify-telegram: sent${result.markdown_fallback ? ' (plain-text fallback)' : ''}\n`);
  else stdout.write(`notify-telegram: send failed (non-fatal): ${result.reason || result.status}\n`);
  return result;
}

if (require.main === module) {
  main().catch((e) => { process.stdout.write(`notify-telegram: error (non-fatal): ${e.message}\n`); });
}

module.exports = { main };
