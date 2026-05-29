// Phase 13 #2: Telegram NL → GitHub issue (Cloudflare Worker entry point).
//
// Serverless (no long-running poller → laptop-free). Telegram delivers each
// message as a webhook POST here; we expand it to a GitHub issue via an LLM
// and reply. The existing Aider Resolver + Phase 13 #1 notifications do the
// rest.
//
// Bindings (set as Worker secrets, see README.md):
//   TELEGRAM_BOT_TOKEN   reply to the user
//   TELEGRAM_WEBHOOK_SECRET   verifies the webhook header
//   ALLOWED_CHAT_ID      comma-separated chat ids allowed to drive dev
//   GITHUB_PAT           creates issues (Contents/Issues RW on the repo)
//   GITHUB_REPO          e.g. "milechy/MCA"
//   OPENROUTER_API_KEY   NL → issue expansion
//   LLM_MODEL            optional, defaults to claude-haiku-4.5

import {
  isAuthorized,
  parseUpdate,
  classifyIntent,
  buildOpenRouterRequest,
  extractIssueJson,
  buildGithubIssueRequest,
  buildTelegramReply,
  HELP_TEXT
} from './lib.mjs';

async function reply(env, chatId, text) {
  const r = buildTelegramReply({ token: env.TELEGRAM_BOT_TOKEN, chatId, text });
  if (!r.ok) return;
  try { await fetch(r.url, r.init); } catch { /* best effort */ }
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('ralph telegram worker', { status: 200 });
    }

    let update;
    try { update = await request.json(); } catch { return new Response('bad json', { status: 200 }); }

    const parsed = parseUpdate(update);
    // Always 200 to Telegram so it doesn't retry; we just stop processing.
    if (!parsed.ok) return new Response('ignored', { status: 200 });

    const auth = isAuthorized({
      headerSecret: request.headers.get('X-Telegram-Bot-Api-Secret-Token'),
      expectedSecret: env.TELEGRAM_WEBHOOK_SECRET,
      chatId: parsed.chatId,
      allowedChatId: env.ALLOWED_CHAT_ID
    });
    if (!auth.ok) return new Response('unauthorized', { status: 200 });

    const { intent } = classifyIntent(parsed.text);

    if (intent === 'help') {
      await reply(env, parsed.chatId, HELP_TEXT);
      return new Response('ok', { status: 200 });
    }
    if (intent === 'status') {
      // Lightweight: point at the Actions tab (full status would need a GH call).
      await reply(env, parsed.chatId, `📊 Live runs: https://github.com/${env.GITHUB_REPO}/actions`);
      return new Response('ok', { status: 200 });
    }
    if (intent === 'stop') {
      await reply(env, parsed.chatId, '🛑 To pause autonomous supply: set repo variable ISSUE_SUPPLIER_ENABLED=0. (This bot only files issues; it has no kill switch by design.)');
      return new Response('ok', { status: 200 });
    }

    // intent === 'develop' → expand NL to an issue
    await reply(env, parsed.chatId, '⏳ 受け取りました。issue に展開しています…');

    const orReq = buildOpenRouterRequest({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.LLM_MODEL,
      userText: parsed.text
    });
    if (!orReq.ok) { await reply(env, parsed.chatId, '⚠️ 設定エラー: OPENROUTER_API_KEY 未設定'); return new Response('ok', { status: 200 }); }

    let issue;
    try {
      const res = await fetch(orReq.url, orReq.init);
      const json = await res.json();
      const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      issue = extractIssueJson(content || '');
    } catch (err) {
      await reply(env, parsed.chatId, `⚠️ LLM 展開に失敗: ${err.message}`);
      return new Response('ok', { status: 200 });
    }

    if (!issue) {
      await reply(env, parsed.chatId, '⚠️ うまく issue に展開できませんでした。もう少し具体的に（対象ファイルや欲しい挙動）書いてもらえますか？');
      return new Response('ok', { status: 200 });
    }
    if (!issue.feasible) {
      await reply(env, parsed.chatId, `🤔 この依頼は自動化には大きすぎ/曖昧すぎるかも:\n${issue.reason}\n小さく切り出して再依頼してください。`);
      return new Response('ok', { status: 200 });
    }

    const ghReq = buildGithubIssueRequest({
      token: env.GITHUB_PAT,
      repo: env.GITHUB_REPO,
      title: issue.title,
      body: `${issue.body}\n\n---\n_filed from Telegram by @${parsed.from || 'user'} via the NL worker_`,
      labels: ['aider-fix']
    });
    if (!ghReq.ok) { await reply(env, parsed.chatId, '⚠️ 設定エラー: GITHUB_PAT / GITHUB_REPO 未設定'); return new Response('ok', { status: 200 }); }

    try {
      const res = await fetch(ghReq.url, ghReq.init);
      const json = await res.json();
      if (json && json.number) {
        await reply(env, parsed.chatId, `📥 issue #${json.number} を作成しました:\n${issue.title}\n${json.html_url}\n\n自動で PR → マージまで進めます。完了したら通知します。`);
      } else {
        await reply(env, parsed.chatId, `⚠️ issue 作成に失敗: ${(json && json.message) || res.status}`);
      }
    } catch (err) {
      await reply(env, parsed.chatId, `⚠️ issue 作成エラー: ${err.message}`);
    }
    return new Response('ok', { status: 200 });
  }
};
