// Phase 13 #2 + 15 #2: Telegram → GitHub (Cloudflare Worker entry point).
//
// Serverless (no long-running poller → laptop-free). Two flows:
//
//  A. Quick one-issue (Phase 13 #2): a short natural-language message →
//     LLM expands to ONE GitHub issue (aider-fix) → reply.
//
//  B. Requirements refinement (Phase 15 #2): a document upload OR a long
//     multi-line message → multi-turn conversation (analyze → clarifying
//     questions → decompose) held in KV, → on approval commit the decomposed
//     items to .github/ralph-backlog.json so the supplier paces them out.
//
// Bindings:
//   secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ALLOWED_CHAT_ID,
//            GITHUB_PAT, GITHUB_REPO, OPENROUTER_API_KEY
//   vars:    LLM_MODEL (quick flow; bare slug)
//   kv:      REFINE_KV (refinement session state)

import {
  isAuthorized,
  parseUpdate,
  classifyIntent,
  buildOpenRouterRequest,
  extractIssueJson,
  buildGithubIssueRequest,
  buildTelegramReply,
  routeKey,
  repoAllowed,
  parseProjectCommand,
  HELP_TEXT
} from './lib.mjs';
import {
  sessionKey, newSession, MAX_ROUNDS,
  buildGetFileRequest, fileDownloadUrl, extractDocOrText, looksLikeRequirements,
  buildGetBacklogRequest, mergeBacklog, buildPutBacklogRequest, assignItemIds
} from './refine-session.mjs';
// Canonical refinement brain (CJS; esbuild/wrangler bundles it for the Worker).
import {
  buildAnalyzeRequest, parseAnalysis,
  buildDecomposeRequest, parseDecomposition,
  isApproval, isCancel, formatQuestions, formatForApproval
} from '../src/ralph/requirements-refiner.js';

async function reply(env, chatId, text) {
  const r = buildTelegramReply({ token: env.TELEGRAM_BOT_TOKEN, chatId, text });
  if (!r.ok) return;
  try { await fetch(r.url, r.init); } catch { /* best effort */ }
}

async function llm(req) {
  const res = await fetch(req.url, req.init);
  const json = await res.json();
  return json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
}

// ---- multi-project repo routing ----------------------------------------
// A Telegram chat/topic can be bound to a specific GitHub repo (stored in KV
// under `route:<chat:thread>`). Unbound → fall back to the default GITHUB_REPO,
// so single-project setups behave exactly as before.
async function getRoute(env, key) {
  if (!env.REFINE_KV) return null;
  try { return await env.REFINE_KV.get(`route:${key}`); } catch { return null; }
}
async function setRoute(env, key, repo) {
  if (env.REFINE_KV) { try { await env.REFINE_KV.put(`route:${key}`, repo); } catch { /* best effort */ } }
}
async function clearRoute(env, key) {
  if (env.REFINE_KV) { try { await env.REFINE_KV.delete(`route:${key}`); } catch { /* best effort */ } }
}
async function resolveRepo(env, key) {
  return (await getRoute(env, key)) || env.GITHUB_REPO;
}

// Handle the /project routing command. Returns true if it consumed the message.
async function handleProjectCommand(env, chatId, key, cmd) {
  if (cmd.action === 'show') {
    const bound = await getRoute(env, key);
    await reply(env, chatId, bound
      ? `📌 このチャット/トピックは \`${bound}\` に紐付いています。`
      : `📌 個別の紐付けなし → 既定 \`${env.GITHUB_REPO || '(未設定)'}\` を使用。\n紐付け: \`/project owner/repo\``);
    return true;
  }
  if (cmd.action === 'clear') {
    await clearRoute(env, key);
    await reply(env, chatId, `🧹 紐付けを解除しました。既定 \`${env.GITHUB_REPO || '(未設定)'}\` に戻ります。`);
    return true;
  }
  // set
  if (!repoAllowed(cmd.repo, env.ALLOWED_REPOS)) {
    await reply(env, chatId, env.ALLOWED_REPOS
      ? `⚠️ \`${cmd.repo}\` は許可リスト(ALLOWED_REPOS)にありません。`
      : `⚠️ \`owner/repo\` 形式で指定してください。例: \`/project milechy/MCA\``);
    return true;
  }
  await setRoute(env, key, cmd.repo);
  await reply(env, chatId, `✅ このチャット/トピックを \`${cmd.repo}\` に紐付けました。以降ここでのアイデア/要件はこのリポジトリへ。`);
  return true;
}

// ---- quick one-issue flow (Phase 13 #2) --------------------------------

async function handleQuickIssue(env, chatId, text, from, repo) {
  await reply(env, chatId, '⏳ 受け取りました。issue に展開しています…');
  const orReq = buildOpenRouterRequest({ apiKey: env.OPENROUTER_API_KEY, model: env.LLM_MODEL, userText: text });
  if (!orReq.ok) { await reply(env, chatId, '⚠️ 設定エラー: OPENROUTER_API_KEY 未設定'); return; }
  let issue;
  try { issue = extractIssueJson(await llm(orReq)); } catch (e) { await reply(env, chatId, `⚠️ LLM 展開に失敗: ${e.message}`); return; }
  if (!issue) { await reply(env, chatId, '⚠️ うまく展開できませんでした。対象ファイルや欲しい挙動をもう少し具体的に。'); return; }
  if (!issue.feasible) { await reply(env, chatId, `🤔 自動化には大きすぎ/曖昧かも:\n${issue.reason}\n小さく切り出して再依頼を。`); return; }
  const targetRepo = repo || env.GITHUB_REPO;
  const ghReq = buildGithubIssueRequest({
    token: env.GITHUB_PAT, repo: targetRepo, title: issue.title,
    body: `${issue.body}\n\n---\n_filed from Telegram by @${from || 'user'} → ${targetRepo}_`, labels: ['aider-fix']
  });
  if (!ghReq.ok) { await reply(env, chatId, '⚠️ 設定エラー: GITHUB_PAT / GITHUB_REPO 未設定'); return; }
  try {
    const j = await (await fetch(ghReq.url, ghReq.init)).json();
    if (j && j.number) await reply(env, chatId, `📥 issue #${j.number}: ${issue.title}\n${j.html_url}\n自動で PR→マージまで進めます。`);
    else await reply(env, chatId, `⚠️ issue 作成に失敗: ${(j && j.message) || '?'}`);
  } catch (e) { await reply(env, chatId, `⚠️ issue 作成エラー: ${e.message}`); }
}

// ---- requirements refinement flow (Phase 15 #2) ------------------------

async function fetchDocText(env, fileId) {
  const gf = buildGetFileRequest({ token: env.TELEGRAM_BOT_TOKEN, fileId });
  if (!gf.ok) return null;
  const meta = await (await fetch(gf.url)).json();
  const filePath = meta && meta.result && meta.result.file_path;
  if (!filePath) return null;
  if (!/\.(md|txt|markdown|text)$/i.test(filePath)) return { unsupported: true };
  const url = fileDownloadUrl({ token: env.TELEGRAM_BOT_TOKEN, filePath });
  const res = await fetch(url);
  return { text: await res.text() };
}

async function saveSession(env, chatId, session) {
  await env.REFINE_KV.put(sessionKey(chatId), JSON.stringify(session), { expirationTtl: 60 * 60 * 24 });
}
async function clearSession(env, chatId) { await env.REFINE_KV.delete(sessionKey(chatId)); }

// analyze the doc (+qa); ask questions or move to decomposition
async function runAnalyze(env, chatId, session) {
  const req = buildAnalyzeRequest({ apiKey: env.OPENROUTER_API_KEY, doc: session.doc, qa: session.qa });
  const analysis = parseAnalysis(await llm(req));
  if (!analysis) { await reply(env, chatId, '⚠️ 要件の解析に失敗しました。もう一度送ってください。'); await clearSession(env, chatId); return; }
  session.analysis = analysis;
  if (!analysis.ready && analysis.open_questions.length && session.rounds < MAX_ROUNDS) {
    session.phase = 'awaiting_answers';
    session.pendingQuestions = analysis.open_questions;
    await saveSession(env, chatId, session);
    await reply(env, chatId, `📝 要約: ${analysis.summary}\n\n${formatQuestions(analysis.open_questions)}\n\n（まとめて返信してください。十分なら「これでOK」でも可）`);
    return;
  }
  await runDecompose(env, chatId, session);
}

async function runDecompose(env, chatId, session, extraFeedback) {
  await reply(env, chatId, '⏳ 分解しています…');
  const qa = extraFeedback ? [...session.qa, { q: '追加の指示', a: extraFeedback }] : session.qa;
  const req = buildDecomposeRequest({ apiKey: env.OPENROUTER_API_KEY, doc: session.doc, qa, summary: session.analysis ? session.analysis.summary : '' });
  const dec = parseDecomposition(await llm(req));
  if (!dec) { await reply(env, chatId, '⚠️ 分解に失敗しました。要件を少し絞って再送してください。'); await clearSession(env, chatId); return; }
  session.decomposition = dec;
  session.phase = 'awaiting_approval';
  await saveSession(env, chatId, session);
  await reply(env, chatId, formatForApproval(dec));
}

async function commitBacklog(env, chatId, session, repo) {
  const targetRepo = repo || env.GITHUB_REPO;
  // get current backlog (for sha + existing items)
  const getReq = buildGetBacklogRequest({ token: env.GITHUB_PAT, repo: targetRepo });
  let existing = { items: [] };
  let sha;
  try {
    const res = await fetch(getReq.url, getReq.init);
    if (res.status === 200) {
      const j = await res.json();
      sha = j.sha;
      const decoded = typeof atob === 'function' ? decodeURIComponent(escape(atob(j.content.replace(/\n/g, '')))) : Buffer.from(j.content, 'base64').toString('utf8');
      try { existing = JSON.parse(decoded); } catch { existing = { items: [] }; }
    }
  } catch { /* file may not exist yet → create */ }

  const items = assignItemIds(session.decomposition.items, existing.items || []);
  const { backlog, added_count } = mergeBacklog(existing, items);
  const putReq = buildPutBacklogRequest({
    token: env.GITHUB_PAT, repo: targetRepo, contentObj: backlog, sha,
    message: `chore: add ${added_count} refined item(s) from Telegram`
  });
  const putRes = await fetch(putReq.url, putReq.init);
  await clearSession(env, chatId);
  if (putRes.status === 200 || putRes.status === 201) {
    await reply(env, chatId, `✅ ${added_count} 件を backlog に追加しました。supplier が順次 PR にします。完了ごとに通知します。`);
  } else {
    const j = await putRes.json().catch(() => ({}));
    await reply(env, chatId, `⚠️ backlog 追加に失敗: ${j.message || putRes.status}`);
  }
}

async function handleRefinement(env, chatId, update, from, repo) {
  const doc = extractDocOrText(update);
  let session = null;
  try { session = await env.REFINE_KV.get(sessionKey(chatId), 'json'); } catch { session = null; }

  // continuing an existing conversation
  if (session) {
    const userText = doc.kind === 'text' ? doc.text : '';
    if (isCancel(userText)) { await clearSession(env, chatId); await reply(env, chatId, '🛑 キャンセルしました。'); return; }
    if (session.phase === 'awaiting_answers') {
      session.qa = [...(session.qa || []), { q: (session.pendingQuestions || []).join(' | '), a: userText || '(no answer)' }];
      session.rounds = (session.rounds || 0) + 1;
      await runAnalyze(env, chatId, session);
      return;
    }
    if (session.phase === 'awaiting_approval') {
      if (isApproval(userText)) { await commitBacklog(env, chatId, session, repo); return; }
      // treat anything else as adjustment feedback → re-decompose
      await runDecompose(env, chatId, session, userText);
      return;
    }
  }

  // new conversation: get the doc text
  let docText = '';
  if (doc.kind === 'document') {
    await reply(env, chatId, '📄 ドキュメントを読み込んでいます…');
    const r = await fetchDocText(env, doc.fileId);
    if (!r) { await reply(env, chatId, '⚠️ ファイルを取得できませんでした。'); return; }
    if (r.unsupported) { await reply(env, chatId, '⚠️ 今は .md / .txt のみ対応です。テキストで貼るか md でアップしてください。'); return; }
    docText = r.text;
  } else {
    docText = doc.text;
  }
  docText = (docText || '').trim();
  if (!docText) { await reply(env, chatId, '⚠️ 要件が空です。'); return; }

  const fresh = newSession(docText);
  await reply(env, chatId, '🧠 要件を整理しています…');
  await runAnalyze(env, chatId, fresh);
}

// ---- entry --------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('ralph telegram worker', { status: 200 });

    let update;
    try { update = await request.json(); } catch { return new Response('bad json', { status: 200 }); }

    const parsed = parseUpdate(update);
    const doc = extractDocOrText(update);
    const chatId = parsed.ok ? parsed.chatId : doc.chatId;
    // documents have no .text so parseUpdate fails; still allow doc uploads.
    if (!chatId) return new Response('ignored', { status: 200 });

    const auth = isAuthorized({
      headerSecret: request.headers.get('X-Telegram-Bot-Api-Secret-Token'),
      expectedSecret: env.TELEGRAM_WEBHOOK_SECRET,
      chatId,
      allowedChatId: env.ALLOWED_CHAT_ID
    });
    if (!auth.ok) return new Response('unauthorized', { status: 200 });

    // Multi-project routing key (chat + forum topic) and the repo it resolves to.
    const key = routeKey(chatId, parsed.threadId || null);
    const repo = await resolveRepo(env, key);

    // control phrases / commands only apply to plain text
    if (parsed.ok) {
      const projectCmd = parseProjectCommand(parsed.text);
      if (projectCmd) { await handleProjectCommand(env, chatId, key, projectCmd); return new Response('ok', { status: 200 }); }
      const { intent } = classifyIntent(parsed.text);
      if (intent === 'help') { await reply(env, chatId, HELP_TEXT); return new Response('ok', { status: 200 }); }
      if (intent === 'status') { await reply(env, chatId, `📊 \`${repo || '(repo未設定)'}\` の実行: https://github.com/${repo}/actions`); return new Response('ok', { status: 200 }); }
      if (intent === 'stop') { await reply(env, chatId, '🛑 自律供給の停止: repo variable ISSUE_SUPPLIER_ENABLED=0'); return new Response('ok', { status: 200 }); }
    }

    // Route: active refine session OR a doc/long text → refinement (needs KV).
    let hasSession = false;
    if (env.REFINE_KV) { try { hasSession = !!(await env.REFINE_KV.get(sessionKey(chatId))); } catch { hasSession = false; } }
    if (env.REFINE_KV && (hasSession || looksLikeRequirements(doc))) {
      await handleRefinement(env, chatId, update, parsed.from, repo);
      return new Response('ok', { status: 200 });
    }

    // else: quick one-issue (needs plain text)
    if (parsed.ok) {
      await handleQuickIssue(env, chatId, parsed.text, parsed.from, repo);
    }
    return new Response('ok', { status: 200 });
  }
};
