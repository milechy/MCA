// Phase 13 #2: Telegram → natural-language → GitHub issue (Cloudflare Worker).
//
// Pure, side-effect-free helpers for the Worker. Kept separate from index.mjs
// so they're unit-testable from the node/playwright runner via dynamic import.
//
// Flow the Worker implements:
//   Telegram webhook (user texts the bot in plain language)
//     → verify it's the allowed chat + the webhook secret header
//     → expand the message into a structured GitHub issue via an LLM
//       (OpenRouter, cheap model) using the same template the backlog uses
//     → create the issue with the aider-fix label (GitHub API)
//     → reply to the user on Telegram
//   The existing Aider Resolver then takes the issue → PR → auto-merge,
//   and Phase 13 #1 notifications report progress back.
//
// This reuses the laptop-free architecture: the Worker is serverless, so
// there's no long-running poller (unlike the existing src/telegram bot).

// ---- auth ---------------------------------------------------------------

// Telegram lets you register a secret token that it sends back in the
// X-Telegram-Bot-Api-Secret-Token header on every webhook call. We verify
// that AND that the message came from the allowed chat id.
export function isAuthorized({ headerSecret, expectedSecret, chatId, allowedChatId } = {}) {
  if (!expectedSecret || headerSecret !== expectedSecret) {
    return { ok: false, reason: 'bad_webhook_secret' };
  }
  // allowedChatId may be a comma-separated list
  const allowed = String(allowedChatId || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(String(chatId))) {
    return { ok: false, reason: 'chat_not_allowed' };
  }
  return { ok: true };
}

// ---- parse the inbound update ------------------------------------------

export function parseUpdate(update = {}) {
  const msg = update.message || update.edited_message || null;
  if (!msg) return { ok: false, reason: 'no_message' };
  const text = (msg.text || '').trim();
  const chatId = msg.chat && msg.chat.id;
  const threadId = msg.message_thread_id || null; // forum/topic id, if any
  if (!text) return { ok: false, reason: 'empty_text', chatId, threadId };
  return { ok: true, text, chatId, threadId, from: msg.from && msg.from.username };
}

// Multi-project routing key. One bot serves many projects by binding each
// Telegram chat (or forum topic) to a different GitHub repo. Key = chat+thread
// so a single forum supergroup with a topic-per-project works, and separate
// groups/DMs also work (threadId null → ":0").
export function routeKey(chatId, threadId) {
  return `${chatId}:${threadId || 0}`;
}

// Validate an "owner/name" repo slug, optionally against a comma-separated
// allowlist. Empty allowlist → any well-formed slug is accepted.
export function repoAllowed(repo, allowedRepos = '') {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))) return false;
  const list = String(allowedRepos || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(repo);
}

// Parse the /project (multi-project routing) command:
//   /project owner/repo      → bind this chat/topic to that repo
//   /project | /project show → report the current binding
//   /project clear|none      → unbind (fall back to the default repo)
// Returns null when the text is not a /project command.
export function parseProjectCommand(text = '') {
  const m = String(text).trim().match(/^\/?(project|proj|repo)\b\s*(.*)$/i);
  if (!m) return null;
  const arg = (m[2] || '').trim();
  if (!arg || /^show$/i.test(arg)) return { action: 'show' };
  if (/^(clear|none|unset|reset)$/i.test(arg)) return { action: 'clear' };
  return { action: 'set', repo: arg.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '') };
}

// Parse the /newproject command — create a brand-new self-driving repo:
//   /newproject <slug> <description...>
// Returns null for non-commands; {ok:false} for malformed; {ok, slug, description}.
export function parseNewProjectCommand(text = '') {
  const m = String(text).trim().match(/^\/?(newproject|new-project|newproj|bootstrap)\b\s*(.*)$/i);
  if (!m) return null;
  const rest = (m[2] || '').trim();
  if (!rest) return { ok: false, reason: 'usage' };
  const parts = rest.split(/\s+/);
  const slug = String(parts.shift()).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return { ok: false, reason: 'invalid_slug' };
  return { ok: true, slug, description: parts.join(' ').trim() };
}

// Build a GitHub Actions workflow_dispatch request (POST; 204 on success).
// Used to trigger MCA's provision-project workflow from the Worker.
export function buildWorkflowDispatchRequest({ token, repo, workflow, ref = 'main', inputs = {} } = {}) {
  if (!token || !repo || !workflow) return { ok: false, reason: 'dispatch_fields_required' };
  return {
    ok: true,
    url: `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ralph-telegram-worker'
      },
      body: JSON.stringify({ ref, inputs })
    }
  };
}

// A few control phrases bypass the LLM (cheap, deterministic).
// NOTE: \b word boundaries don't work after CJK characters, so we match by
// stripping a leading slash and testing equality / prefix against keyword
// lists rather than using \b.
const CONTROL_KEYWORDS = {
  status: ['status', '状態', 'ステータス'],
  help: ['help', 'ヘルプ', '使い方'],
  stop: ['stop', 'pause', '止めて', '停止']
};

export function classifyIntent(text = '') {
  const t = text.trim().toLowerCase().replace(/^\//, '');
  for (const [intent, kws] of Object.entries(CONTROL_KEYWORDS)) {
    for (const kw of kws) {
      const k = kw.toLowerCase();
      // exact, or keyword followed by a space/punctuation (so "status now"
      // counts but "statusify the thing" does not for ASCII words).
      if (t === k || t.startsWith(k + ' ') || (/[^a-z]/.test(k) && t.startsWith(k))) {
        return { intent };
      }
    }
  }
  return { intent: 'develop' };
}

// ---- LLM expansion: NL → structured issue ------------------------------

export const NL_TO_ISSUE_SYSTEM = [
  'You convert a casual development request into a GitHub issue for an',
  'autonomous coding agent (Aider). Output STRICT JSON only:',
  '{ "title": string, "body": string, "feasible": boolean, "reason": string }.',
  'The body MUST use this shape:',
  '## Task',
  '<what to do, naming the target file path(s) in backticks like `src/x.js`>',
  '## Requirements',
  '- <bullet requirements, including a `tests/...spec.js` test file using @playwright/test>',
  '## Context',
  '<why / how it fits>',
  'Rules: prefer ONE small-to-medium, clearly-scoped change. If the request',
  'is too vague or too large to do safely in one autonomous pass, set',
  'feasible=false and explain in reason. Always put concrete file paths in',
  'backticks so the resolver can find them.'
].join('\n');

export function buildOpenRouterRequest({ apiKey, model, userText, system = NL_TO_ISSUE_SYSTEM } = {}) {
  if (!apiKey || !userText) return { ok: false, reason: 'apikey_text_required' };
  return {
    ok: true,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // BARE slug — direct OpenRouter API rejects the `openrouter/` prefix
        // (that form is only for opencode/aider/LiteLLM). Bug found by the
        // Phase 15 #1 live test; same class as requirements-refiner.
        model: model || 'anthropic/claude-haiku-4.5',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText }
        ],
        max_tokens: 1200,
        temperature: 0.2
      })
    }
  };
}

// Pull the JSON object out of an LLM response (handles ```json fences and
// leading prose).
export function extractIssueJson(content = '') {
  if (typeof content !== 'string' || !content.trim()) return null;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    if (typeof obj.title !== 'string' || typeof obj.body !== 'string') return null;
    return {
      title: obj.title.trim(),
      body: obj.body,
      feasible: obj.feasible !== false, // default true
      reason: typeof obj.reason === 'string' ? obj.reason : ''
    };
  } catch { return null; }
}

// ---- GitHub issue creation ---------------------------------------------

export function buildGithubIssueRequest({ token, repo, title, body, labels = ['aider-fix'] } = {}) {
  if (!token || !repo || !title || !body) return { ok: false, reason: 'github_fields_required' };
  return {
    ok: true,
    url: `https://api.github.com/repos/${repo}/issues`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ralph-telegram-worker'
      },
      body: JSON.stringify({ title, body, labels })
    }
  };
}

// ---- Telegram reply -----------------------------------------------------

export function buildTelegramReply({ token, chatId, text } = {}) {
  if (!token || !chatId || !text) return { ok: false, reason: 'reply_fields_required' };
  const form = new URLSearchParams();
  form.set('chat_id', String(chatId));
  form.set('text', text);
  form.set('disable_web_page_preview', 'true');
  return {
    ok: true,
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    }
  };
}

export const HELP_TEXT = [
  '🤖 Ralph dev bot — just describe what you want built, e.g.:',
  '“src/ralph/utils に debounce ヘルパー追加して、テストも”',
  '',
  'I expand it into a GitHub issue, the resolver writes the code, opens a PR',
  'and auto-merges. You get a message when it lands.',
  '',
  '複数プロジェクト: チャット/トピックごとに紐付け',
  '  /newproject <slug> <説明> … 新規プロジェクト(repo)を作成し、このチャットに紐付け',
  '  /project owner/repo       … このチャット/トピックを既存リポジトリに紐付け',
  '  /project                   … 現在の紐付けを表示',
  '  /project clear             … 紐付け解除（既定リポジトリに戻る）',
  '',
  'Commands: status / help / stop / project / newproject'
].join('\n');
