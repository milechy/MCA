// Phase 4 #3: Claude-based PR reviewer.
//
// Standalone module that takes a PR number, fetches its title/body/diff via
// `gh`, asks a reviewer model (Claude sonnet by default) to return a strict
// JSON verdict, and records the call cost. Phase 4 #4 will wire this into
// the autonomous-loop's new PR_REVIEW phase; this module just provides the
// primitive.
//
// Why Claude (not Kimi):
// - Reviewing requires judgement that survives misleading prose; Phase 3
//   dogfood showed Kimi tends to overfit to local patterns. Claude sonnet
//   is the same model already used by the planner, so the operator only
//   funds two distinct models in a typical run.
// - Cost: roughly $0.02-0.05 per small PR; pricing is recorded via the
//   shared cost ledger so dashboards can spot reviewer cost regressions.
//
// Output contract is intentionally narrow so Phase 4 #4 can dispatch on it
// without parsing prose: `{ verdict, issues[], summary, cost_usd }`.

const { spawnSync } = require('node:child_process');
const { recordKimiCall } = require('./kimi-cost-tracker');

const DEFAULT_REVIEWER_MODEL = 'openrouter/anthropic/claude-sonnet-4.6';
const DEFAULT_MAX_RETRIES = 1;
const GH_TIMEOUT_MS = 30000;
const OPENCODE_TIMEOUT_MS = 180000;
const MAX_DIFF_CHARS = 80000; // ~20k tokens, comfortably under Claude's 200k context

const VALID_VERDICTS = new Set(['approve', 'request_changes', 'comment']);
const VALID_SEVERITIES = new Set(['blocker', 'warn', 'nit']);

const REVIEW_PROMPT_TEMPLATE = `You are a senior staff engineer reviewing a pull request before it is merged. Be honest and terse.

PR TITLE: {TITLE}

PR BODY:
{BODY}

PR DIFF (unified):
{DIFF}

Return ONLY a JSON object — no prose before or after, no markdown fence. The exact shape is:

{
  "verdict": "approve" | "request_changes" | "comment",
  "issues": [
    { "file": "src/x.js", "line": 42, "severity": "blocker" | "warn" | "nit", "message": "..." }
  ],
  "summary": "1-2 sentence overall assessment"
}

Rules for verdict:
- "approve" — there are zero blocker issues and the change is well-formed for what the title/body claims.
- "request_changes" — at least one blocker issue (correctness bug, security regression, deleted pre-existing tests/functions, broken contract, secret leak).
- "comment" — no blockers but there are warn or nit issues worth surfacing.

Rules for issues:
- Keep the list short. At most 5 entries unless something genuinely bad is going on.
- Severity "blocker" is reserved for things that should stop merge. "warn" = significant style or maintainability concern. "nit" = optional polish.
- "line" is optional; omit it for whole-file or cross-file issues.
- "file" must be a path that appears in the diff.
- Focus on: correctness, security (secrets / shell injection / RLS / dependency surface), deleted pre-existing tests, missing test coverage for the new logic, scope creep beyond the title.

Do NOT comment on cosmetic whitespace or import ordering unless it changes behavior. Do NOT suggest "consider adding more tests" without naming the specific path / scenario.
`;

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractReviewerJson(stdout) {
  if (stdout == null) return null;
  const raw = String(stdout).trim();
  if (raw.length === 0) return null;
  // Fast path: pure JSON (unit-test fake spawns).
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct) && typeof direct.verdict === 'string') {
      return direct;
    }
  } catch (_err) { /* fall through */ }
  // NDJSON envelope from `opencode run --format json`.
  const textChunks = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const event = JSON.parse(t);
      if (event && event.type === 'text' && event.part && typeof event.part.text === 'string') {
        textChunks.push(event.part.text);
      }
    } catch (_err) { /* skip non-JSON noise */ }
  }
  if (textChunks.length === 0) return null;
  try {
    return JSON.parse(stripCodeFence(textChunks.join('')));
  } catch (_err) {
    return null;
  }
}

function validateReviewerOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (!VALID_VERDICTS.has(parsed.verdict)) return false;
  if (!Array.isArray(parsed.issues)) return false;
  for (const issue of parsed.issues) {
    if (!issue || typeof issue !== 'object') return false;
    if (typeof issue.file !== 'string' || issue.file.length === 0) return false;
    if (!VALID_SEVERITIES.has(issue.severity)) return false;
    if (typeof issue.message !== 'string' || issue.message.length === 0) return false;
    if (issue.line != null && !Number.isFinite(issue.line)) return false;
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.length === 0) return false;
  // Verdict / issues consistency.
  const hasBlocker = parsed.issues.some((i) => i.severity === 'blocker');
  if (hasBlocker && parsed.verdict === 'approve') return false;
  return true;
}

function fetchPrMetadata({ pr_number, spawn = spawnSync, env = process.env }) {
  const result = spawn('gh', ['pr', 'view', String(pr_number), '--json', 'title,body,baseRefName,headRefName,additions,deletions'], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    env: { PATH: env.PATH || '', HOME: env.HOME || '', GH_TOKEN: env.GH_TOKEN || env.GITHUB_TOKEN || '', GITHUB_TOKEN: env.GITHUB_TOKEN || env.GH_TOKEN || '' }
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: 'gh_pr_view_failed', stderr_preview: String(result.stderr || '').slice(0, 300) };
  }
  try {
    return { ok: true, metadata: JSON.parse(result.stdout || '{}') };
  } catch (_err) {
    return { ok: false, reason: 'gh_pr_view_malformed_json' };
  }
}

function fetchPrDiff({ pr_number, spawn = spawnSync, env = process.env }) {
  const result = spawn('gh', ['pr', 'diff', String(pr_number)], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 4,
    env: { PATH: env.PATH || '', HOME: env.HOME || '', GH_TOKEN: env.GH_TOKEN || env.GITHUB_TOKEN || '', GITHUB_TOKEN: env.GITHUB_TOKEN || env.GH_TOKEN || '' }
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: 'gh_pr_diff_failed', stderr_preview: String(result.stderr || '').slice(0, 300) };
  }
  let diff = String(result.stdout || '');
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + '\n…[diff truncated for reviewer context]';
    truncated = true;
  }
  return { ok: true, diff, truncated };
}

function reviewPullRequest({
  pr_number,
  rootDir,
  env = process.env,
  reviewerModel = DEFAULT_REVIEWER_MODEL,
  maxRetries = DEFAULT_MAX_RETRIES,
  spawn = spawnSync,
  now = () => new Date()
} = {}) {
  if (pr_number == null || !Number.isFinite(Number(pr_number))) {
    return { ok: false, reason: 'pr_number_required' };
  }
  if (!env.OPENROUTER_API_KEY) {
    return { ok: false, reason: 'openrouter_api_key_missing' };
  }

  const meta = fetchPrMetadata({ pr_number, spawn, env });
  if (!meta.ok) return { ok: false, reason: meta.reason, pr_number, stderr_preview: meta.stderr_preview || null };

  const diffR = fetchPrDiff({ pr_number, spawn, env });
  if (!diffR.ok) return { ok: false, reason: diffR.reason, pr_number, stderr_preview: diffR.stderr_preview || null };

  const title = String(meta.metadata.title || '').slice(0, 400);
  const body = String(meta.metadata.body || '').slice(0, 8000);

  let prompt = REVIEW_PROMPT_TEMPLATE
    .replace('{TITLE}', title)
    .replace('{BODY}', body || '(empty body)')
    .replace('{DIFF}', diffR.diff);

  const scrubbedEnv = {
    PATH: env.PATH || '',
    HOME: env.HOME || '',
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY
  };

  const maxAttempts = Math.max(1, Number(maxRetries) + 1);
  let lastRawPreview = '';
  let parsed = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      prompt = 'YOUR PREVIOUS OUTPUT WAS NOT VALID JSON OR FAILED SCHEMA. Return ONLY the JSON object specified, nothing else.\n' + prompt;
    }
    const result = spawn('opencode', ['run', '--model', reviewerModel, '--format', 'json', prompt], {
      encoding: 'utf8',
      timeout: OPENCODE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 4,
      env: scrubbedEnv
    });
    if (result.error || result.status !== 0) {
      return { ok: false, reason: 'reviewer_dispatch_failed', pr_number, exit_code: result.status, stderr_preview: String(result.stderr || '').slice(0, 300) };
    }
    lastRawPreview = String(result.stdout || '').slice(0, 1000);
    const candidate = extractReviewerJson(result.stdout);
    if (candidate && validateReviewerOutput(candidate)) {
      parsed = candidate;
      break;
    }
  }

  if (!parsed) {
    return { ok: false, reason: 'reviewer_invalid_response', pr_number, last_raw_preview: lastRawPreview };
  }

  // Record cost (best-effort).
  let ledgerCost = 0;
  try {
    const rec = recordKimiCall({
      rootDir,
      story_id: `PR-${pr_number}`,
      prompt_text: prompt,
      output_text: JSON.stringify(parsed),
      model: reviewerModel,
      now: now()
    });
    ledgerCost = (rec && rec.entry && rec.entry.cost_usd) || 0;
  } catch (_err) { /* non-fatal */ }

  return {
    ok: true,
    pr_number: Number(pr_number),
    verdict: parsed.verdict,
    issues: parsed.issues,
    summary: parsed.summary,
    cost_usd: ledgerCost,
    reviewer_model: reviewerModel,
    diff_truncated: diffR.truncated === true,
    pr_title: title
  };
}

module.exports = {
  DEFAULT_REVIEWER_MODEL,
  DEFAULT_MAX_RETRIES,
  MAX_DIFF_CHARS,
  REVIEW_PROMPT_TEMPLATE,
  VALID_VERDICTS,
  VALID_SEVERITIES,
  stripCodeFence,
  extractReviewerJson,
  validateReviewerOutput,
  fetchPrMetadata,
  fetchPrDiff,
  reviewPullRequest
};
