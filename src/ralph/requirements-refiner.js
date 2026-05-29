// Phase 15 #1: requirements refiner — the brain of "upload a requirements
// doc → organize / brush up / decompose into a backlog".
//
// Pure: builds LLM requests + parses LLM responses + small conversation
// helpers. The DRIVER (CLI today, Telegram+KV worker in 15 #2) does the
// actual fetch I/O and holds the conversation transport. Keeping the brain
// here means the same logic powers both surfaces and is fully unit-testable.
//
// Conversation shape:
//   1. analyze(doc [+ prior Q&A]) → { summary, open_questions[], features[],
//      ready }  (ready=true when the LLM judges the spec clear enough)
//   2. while !ready and there are open_questions → ask them, collect answers,
//      re-analyze with the Q&A appended.
//   3. decompose(doc + Q&A) → ordered backlog items [{ id, title, body }] +
//      notes (deps / sequencing).
//   4. present for approval → on approval, the driver commits the items to
//      .github/ralph-backlog.json (15 #2) or files them.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// NOTE: direct OpenRouter API calls use the BARE slug (no `openrouter/`
// prefix). The `openrouter/...` form is only for opencode/aider/LiteLLM.
// Refinement wants the stronger model.
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

// ---- prompts ------------------------------------------------------------

const ANALYZE_SYSTEM = [
  'You are a senior requirements engineer. Given a raw requirements document',
  '(possibly vague, unstructured, or contradictory) and any prior clarifying',
  'Q&A, produce STRICT JSON only:',
  '{',
  '  "summary": string,                // crisp restatement of the intent',
  '  "features": [{ "name": string, "description": string }],',
  '  "open_questions": [string],       // ambiguities/gaps that block a clean build; [] if none',
  '  "risks": [string],                // contradictions / underspecified areas',
  '  "ready": boolean                  // true when clear enough to decompose without more answers',
  '}',
  'Rules: ask only questions that genuinely change the implementation. If the',
  'prior Q&A already resolves the ambiguities, set ready=true and',
  'open_questions=[]. Keep questions concrete and answerable in one line.'
].join('\n');

const DECOMPOSE_SYSTEM = [
  'You are a tech lead breaking a refined requirement into a backlog for an',
  'autonomous coding agent (Aider). Each item must be small-to-medium and',
  'independently buildable. Output STRICT JSON only:',
  '{',
  '  "items": [',
  '    { "id": "BL-<n>", "title": string,',
  '      "body": string,               // ## Task (with `file/paths` in backticks) / ## Requirements (incl a tests/...spec file) / ## Context',
  '      "depends_on": [string] }      // ids of items that must land first; [] if none',
  '  ],',
  '  "notes": string                   // sequencing / cross-cutting concerns',
  '}',
  'Rules: order items so dependencies come first. Put concrete file paths in',
  'backticks. Each item should be doable in one autonomous pass; split big',
  'features into several items. Number ids BL-1, BL-2, ... in build order.',
  'Keep each body concise (roughly 5-12 lines) so the whole JSON stays well',
  'under the token budget — detail the WHAT and the test file, not an essay.',
  'Aim for at most ~12 items; merge trivially small ones.'
].join('\n');

// ---- request builders ---------------------------------------------------

function buildAnalyzeRequest({ apiKey, model, doc, qa = [] } = {}) {
  if (!apiKey || !doc) return { ok: false, reason: 'apikey_doc_required' };
  const qaBlock = qa.length
    ? '\n\n--- Prior clarifying Q&A ---\n' + qa.map((p, i) => `Q${i + 1}: ${p.q}\nA${i + 1}: ${p.a}`).join('\n')
    : '';
  return {
    ok: true,
    url: OPENROUTER_URL,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: ANALYZE_SYSTEM },
          { role: 'user', content: `--- Requirements document ---\n${doc}${qaBlock}` }
        ],
        max_tokens: 2000,
        temperature: 0.2
      })
    }
  };
}

function buildDecomposeRequest({ apiKey, model, doc, qa = [], summary = '' } = {}) {
  if (!apiKey || !doc) return { ok: false, reason: 'apikey_doc_required' };
  const qaBlock = qa.length
    ? '\n\n--- Resolved Q&A ---\n' + qa.map((p, i) => `Q${i + 1}: ${p.q}\nA${i + 1}: ${p.a}`).join('\n')
    : '';
  return {
    ok: true,
    url: OPENROUTER_URL,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: DECOMPOSE_SYSTEM },
          { role: 'user', content: `${summary ? `Refined summary: ${summary}\n\n` : ''}--- Requirements ---\n${doc}${qaBlock}` }
        ],
        max_tokens: 8000,
        temperature: 0.2
      })
    }
  };
}

// ---- response parsers ----------------------------------------------------

function extractJson(content = '') {
  if (typeof content !== 'string' || !content.trim()) return null;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function parseAnalysis(content) {
  const obj = extractJson(content);
  if (!obj || typeof obj.summary !== 'string') return null;
  return {
    summary: obj.summary.trim(),
    features: Array.isArray(obj.features) ? obj.features.filter((f) => f && f.name) : [],
    open_questions: Array.isArray(obj.open_questions) ? obj.open_questions.filter((q) => typeof q === 'string' && q.trim()) : [],
    risks: Array.isArray(obj.risks) ? obj.risks.filter((r) => typeof r === 'string') : [],
    ready: obj.ready === true || (Array.isArray(obj.open_questions) && obj.open_questions.length === 0)
  };
}

function parseDecomposition(content) {
  const obj = extractJson(content);
  if (!obj || !Array.isArray(obj.items)) return null;
  const items = obj.items
    .filter((it) => it && typeof it.title === 'string' && typeof it.body === 'string')
    .map((it, i) => ({
      id: typeof it.id === 'string' && it.id.trim() ? it.id.trim() : `BL-${i + 1}`,
      title: it.title.trim(),
      body: it.body,
      depends_on: Array.isArray(it.depends_on) ? it.depends_on.filter((d) => typeof d === 'string') : []
    }));
  if (!items.length) return null;
  return { items, notes: typeof obj.notes === 'string' ? obj.notes : '' };
}

// ---- conversation helpers -----------------------------------------------

function isApproval(text = '') {
  return /^\s*(ok|yes|approve|approved|承認|いいよ|これでお願い|go|ship|進めて)\s*$/i.test(String(text).trim());
}

function isCancel(text = '') {
  return /^\s*(cancel|stop|やめ|中止|キャンセル)\s*$/i.test(String(text).trim());
}

// Decide what the driver should do next given the current session.
// session: { phase, doc, qa:[{q,a}], analysis, pendingQuestions:[], decomposition }
// Returns { action, ... } where action ∈
//   analyze | ask | decompose | present | commit | done | cancel | need_doc
function nextStep(session = {}) {
  if (!session.doc) return { action: 'need_doc' };
  if (session.cancelled) return { action: 'cancel' };
  if (!session.analysis) return { action: 'analyze' };
  if (!session.analysis.ready && (session.pendingQuestions || []).length) {
    return { action: 'ask', questions: session.pendingQuestions };
  }
  if (!session.decomposition) return { action: 'decompose' };
  if (!session.approved) return { action: 'present', decomposition: session.decomposition };
  return { action: 'commit', items: session.decomposition.items };
}

// ---- formatters ----------------------------------------------------------

function formatQuestions(questions = []) {
  if (!questions.length) return '(no open questions)';
  return ['🤔 確認させてください:', ...questions.map((q, i) => `${i + 1}. ${q}`)].join('\n');
}

function formatForApproval(decomposition) {
  if (!decomposition || !decomposition.items) return '(no items)';
  const lines = [`📋 ${decomposition.items.length} 件に分解しました:`];
  for (const it of decomposition.items) {
    const dep = it.depends_on && it.depends_on.length ? ` (after ${it.depends_on.join(', ')})` : '';
    lines.push(`• ${it.id}: ${it.title}${dep}`);
  }
  if (decomposition.notes) lines.push(`\n📝 ${decomposition.notes}`);
  lines.push('\nこれで backlog に入れて開発を始めますか？ (OK / キャンセル / 直したい点)');
  return lines.join('\n');
}

// Convert decomposition items to .github/ralph-backlog.json item shape.
function toBacklogItems(decomposition, { prefix = 'REQ' } = {}) {
  if (!decomposition || !decomposition.items) return [];
  return decomposition.items.map((it, i) => ({
    id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    title: it.title,
    body: it.body
  }));
}

module.exports = {
  OPENROUTER_URL,
  DEFAULT_MODEL,
  ANALYZE_SYSTEM,
  DECOMPOSE_SYSTEM,
  buildAnalyzeRequest,
  buildDecomposeRequest,
  extractJson,
  parseAnalysis,
  parseDecomposition,
  isApproval,
  isCancel,
  nextStep,
  formatQuestions,
  formatForApproval,
  toBacklogItems
};
