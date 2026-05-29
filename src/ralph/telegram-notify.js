// Phase 13 #1: push notifications to Telegram from GitHub Actions.
//
// The existing src/telegram/ bot is POLLING-based — it needs a long-running
// process, which reintroduces the exact laptop-dependency we removed by
// moving the loop onto GitHub Actions. So for OUTBOUND notifications we do
// NOT use the bot; we just POST to the Telegram Bot API directly from the
// workflow (a stateless HTTP call). Cost/status messages reach the user's
// phone with zero long-running infrastructure.
//
// Safety: if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set, this is a
// clean no-op (never fails the workflow). Notifications are best-effort.
//
// Pure builders + injected fetch so tests never hit the network.

const TELEGRAM_API = 'https://api.telegram.org';

function shouldNotify(env = process.env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

// Build the request (url + form body) without sending. Pure.
function buildSendMessage({ token, chatId, text, parseMode = 'Markdown' } = {}) {
  if (!token || !chatId || !text) {
    return { ok: false, reason: 'token_chat_text_required' };
  }
  const form = new URLSearchParams();
  form.set('chat_id', String(chatId));
  form.set('text', String(text));
  if (parseMode) form.set('parse_mode', parseMode);
  // disable_web_page_preview keeps PR links from ballooning the message
  form.set('disable_web_page_preview', 'true');
  return {
    ok: true,
    url: `${TELEGRAM_API}/bot${token}/sendMessage`,
    body: form.toString()
  };
}

// Send a notification. Best-effort: returns { skipped } when unconfigured,
// { ok:false } on transport error (never throws), { ok:true } on success.
// Telegram's Markdown parser is strict; on a parse error we retry as plain
// text so a stray underscore in a model slug can't drop the message.
async function notify({ env = process.env, text, fetchImpl = fetch } = {}) {
  if (!shouldNotify(env)) return { skipped: true, reason: 'telegram_not_configured' };
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  async function post(parseMode) {
    const req = buildSendMessage({ token, chatId, text, parseMode });
    if (!req.ok) return req;
    const res = await fetchImpl(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: req.body
    });
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { ok: !!(json && json.ok), status: res.status, response: json };
  }

  try {
    const first = await post('Markdown');
    if (first.ok) return first;
    // retry plain text if Markdown failed (likely entity parse error)
    const plain = await post(null);
    return plain.ok ? { ...plain, markdown_fallback: true } : plain;
  } catch (err) {
    return { ok: false, reason: 'send_failed', error: err.message };
  }
}

// Message formatters for the events we care about (kept here so the wording
// is consistent and testable).
const fmt = {
  prMerged: ({ issue, pr, model, cost }) =>
    `✅ *Auto-merged* PR #${pr} (issue #${issue})\nmodel: \`${model || '?'}\`  cost: ${cost != null ? `$${cost}` : 'n/a'}`,
  prOpenedNoMerge: ({ issue, pr }) =>
    `🔵 PR #${pr} opened for issue #${issue} — auto-merge pending / manual review`,
  noDiff: ({ issue, run }) =>
    `⚠️ Aider produced *no diff* for issue #${issue}. Needs attention.\n${run || ''}`,
  costCeiling: ({ kind, value, cap }) =>
    `⛔ *Cost ceiling hit* (${kind}): ${value} ≥ ${cap}. Aider halted — raise the cap or wait for reset.`,
  supplierFiled: ({ issueTitle, url }) =>
    `📤 Supplier filed: ${issueTitle}\n${url || ''}`,
  backlogExhausted: () =>
    `📭 Backlog *exhausted* — supplier idle. Add items to .github/ralph-backlog.json to keep the loop fed.`,
  dailyDigest: ({ merged, cost, openPrs }) =>
    `📊 Daily: ${merged} PRs auto-merged, ~$${cost} spent, ${openPrs} open auto-PRs.`
};

module.exports = {
  TELEGRAM_API,
  shouldNotify,
  buildSendMessage,
  notify,
  fmt
};
