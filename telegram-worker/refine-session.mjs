// Phase 15 #2: Telegram requirements-refinement session — pure helpers.
//
// Wraps the Phase 15 #1 brain (requirements-refiner) into a multi-turn
// conversation that the stateless Cloudflare Worker can drive by persisting
// state in KV between webhook calls. Plus the GitHub Contents-API and
// Telegram getFile request builders the Worker needs.
//
// Session shape (stored in KV under key `refine:<chatId>`):
//   { phase, doc, qa:[{q,a}], analysis, pendingQuestions:[], decomposition,
//     rounds, approved }
//   phase ∈ idle | awaiting_answers | awaiting_approval
//
// The brain (analyze/decompose prompts + parsers) is imported from the repo
// copy of requirements-refiner that the bootstrapper/worker bundle ships.
// To keep the Worker self-contained we re-implement the few pure bits it
// needs here rather than importing the CJS module (Workers are ESM); the
// canonical logic + tests live in src/ralph/requirements-refiner.js and
// tests/ralph/requirements-refiner.spec.js.

export const MAX_ROUNDS = 3;

export function sessionKey(chatId) {
  return `refine:${chatId}`;
}

export function newSession(doc) {
  return { phase: 'idle', doc, qa: [], analysis: null, pendingQuestions: [], decomposition: null, rounds: 0, approved: false };
}

// Telegram: to read an uploaded document we first resolve its file_path,
// then download from the file URL.
export function buildGetFileRequest({ token, fileId } = {}) {
  if (!token || !fileId) return { ok: false, reason: 'token_fileid_required' };
  return { ok: true, url: `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}` };
}

export function fileDownloadUrl({ token, filePath } = {}) {
  if (!token || !filePath) return null;
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

// Extract a document/file or long text from an update message.
export function extractDocOrText(update = {}) {
  const msg = update.message || update.edited_message || {};
  if (msg.document) {
    return { kind: 'document', fileId: msg.document.file_id, fileName: msg.document.file_name || 'doc', chatId: msg.chat && msg.chat.id };
  }
  const text = (msg.text || '').trim();
  return { kind: 'text', text, chatId: msg.chat && msg.chat.id };
}

// A message is "a requirements doc to refine" (vs a quick one-issue request)
// when it's a document upload OR a long multi-line text.
export function looksLikeRequirements({ kind, text }) {
  if (kind === 'document') return true;
  if (!text) return false;
  const lines = text.split('\n').filter((l) => l.trim()).length;
  return text.length >= 280 || lines >= 4;
}

// ---- GitHub Contents API: append items to .github/ralph-backlog.json -----

export function buildGetBacklogRequest({ token, repo, path = '.github/ralph-backlog.json', branch } = {}) {
  if (!token || !repo) return { ok: false, reason: 'token_repo_required' };
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  return {
    ok: true,
    url: `https://api.github.com/repos/${repo}/contents/${path}${ref}`,
    init: { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ralph-refine-worker' } }
  };
}

// Merge new items into an existing backlog object (pure). Dedups by id.
export function mergeBacklog(existing, newItems = []) {
  const base = existing && Array.isArray(existing.items) ? existing : { version: 'ralph-backlog-v1', items: [] };
  const haveIds = new Set(base.items.map((i) => i.id));
  const added = newItems.filter((i) => i && i.id && !haveIds.has(i.id));
  return { backlog: { ...base, version: base.version || 'ralph-backlog-v1', items: [...base.items, ...added] }, added_count: added.length };
}

// PUT the updated backlog (Contents API needs the prior blob sha).
export function buildPutBacklogRequest({ token, repo, path = '.github/ralph-backlog.json', branch, contentObj, sha, message } = {}) {
  if (!token || !repo || !contentObj) return { ok: false, reason: 'token_repo_content_required' };
  const json = JSON.stringify(contentObj, null, 2) + '\n';
  const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json, 'utf8').toString('base64');
  const body = { message: message || 'chore: append refined requirements to backlog', content: b64 };
  if (sha) body.sha = sha;
  if (branch) body.branch = branch;
  return {
    ok: true,
    url: `https://api.github.com/repos/${repo}/contents/${path}`,
    init: {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'ralph-refine-worker' },
      body: JSON.stringify(body)
    }
  };
}

// Give the decomposed items stable REQ-NNN ids unique against what's already
// filed (so repeated refinements don't collide).
export function assignItemIds(items = [], existingItems = []) {
  let max = 0;
  for (const it of existingItems) {
    const m = String(it.id || '').match(/^REQ-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  // map old decomposition ids → new REQ-NNN so depends_on stays valid (Phase 12 #2)
  const idMap = {};
  items.forEach((it, i) => { idMap[it.id] = `REQ-${String(max + i + 1).padStart(3, '0')}`; });
  return items.map((it) => {
    const deps = (Array.isArray(it.depends_on) ? it.depends_on : []).map((d) => idMap[d]).filter(Boolean);
    const out = { id: idMap[it.id], title: it.title, body: it.body };
    if (deps.length) out.depends_on = deps;
    return out;
  });
}
