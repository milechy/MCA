const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Phase 11-A: routing-learning substrate (recorder side).
//
// Turns a finished story + its cost-ledger rows into a NORMALIZED outcome
// record (the thing 11-B visualizes, 11-D calibrates against, 11-E would
// learn from), and writes it to a PLUGGABLE sink.
//
// Sinks:
//   local (default)  → append to .ralph/outcomes.jsonl. Always works, no
//                      external dependency. This is what runs today.
//   supabase         → upsert into tasks + model_executions (migration
//                      20260529000000_phase11a_routing_learning.sql).
//                      Activated by RALPH_OUTCOME_SINK=supabase once
//                      `supabase start` / a remote project is linked.
//
// The recorder is intentionally side-effect-light and dependency-free so
// it can be called from the Ralph daemon AND (later) from a GitHub Actions
// step without dragging in a DB driver. The supabase sink shells out to
// the `supabase`/`psql` boundary via an injected `writeSupabase` fn so the
// core stays unit-testable.

// ----------------------------------------------------------------------
// Context-feature extraction (the inputs NemClaw routes on; §8.5)
// ----------------------------------------------------------------------

const KNOWN_DIFFICULTIES = ['trivial', 'easy', 'medium', 'hard', 'architectural'];

function inferLanguage(paths = []) {
  const exts = paths
    .map((p) => (String(p).match(/\.([a-z0-9]+)$/i) || [])[1])
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  if (!exts.length) return 'unknown';
  // most common extension wins
  const counts = {};
  for (const e of exts) counts[e] = (counts[e] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const map = { js: 'js', ts: 'ts', tsx: 'ts', jsx: 'js', py: 'py', md: 'md', yml: 'yaml', yaml: 'yaml', json: 'json', sh: 'sh' };
  return map[top] || top;
}

// Classify the task kind from the requirement text. Cheap heuristic; the
// planner could later emit this directly.
function inferTaskKind(requirement = '', requested_paths = []) {
  const r = String(requirement).toLowerCase();
  const hasCreate = /\(create\)|create a new|add a new (file|module|helper)/i.test(requirement);
  const hasModify = /\(modify existing\)|modify |refactor|extract |rename /i.test(requirement);
  const onlyTests = requested_paths.length > 0 && requested_paths.every((p) => /test|spec/i.test(p));
  const onlyDocs = requested_paths.length > 0 && requested_paths.every((p) => /\.md$|docs\//i.test(p));
  if (onlyTests) return 'test_only';
  if (onlyDocs) return 'docs';
  if (/\brefactor\b/.test(r)) return 'refactor';
  if (/\bbug|\bfix\b|incorrect|wrong behavior/.test(r)) return 'bugfix';
  if (hasCreate && hasModify) return 'mixed';
  if (hasCreate) return 'create';
  if (hasModify) return 'modify';
  return 'mixed';
}

// Discretized grouping key for bandit/aggregation. Keep it coarse so each
// bucket accrues enough samples at month-1000 volume (§8 sparsity warning).
function contextBucket({ difficulty, task_kind, language, requested_paths }) {
  const files = !requested_paths ? '0f' : requested_paths <= 1 ? '1f' : requested_paths <= 3 ? '2-3f' : '4+f';
  return [difficulty || 'unknown', task_kind || 'unknown', language || 'unknown', files].join('|');
}

function extractContext(story = {}) {
  const requested_paths = Array.isArray(story.requested_paths) ? story.requested_paths : [];
  const difficulty = KNOWN_DIFFICULTIES.includes(story.difficulty) ? story.difficulty : (story.difficulty || 'unknown');
  const language = inferLanguage(requested_paths);
  const task_kind = inferTaskKind(story.requirement || '', requested_paths);
  return {
    story_id: story.story_id,
    difficulty,
    predicted_difficulty: difficulty, // planner's call; calibrated in 11-D
    task_kind,
    requested_paths: requested_paths.length,
    language,
    spec_chars: String(story.requirement || '').length,
    context_bucket: contextBucket({ difficulty, task_kind, language, requested_paths: requested_paths.length })
  };
}

// ----------------------------------------------------------------------
// Outcome derivation (the reward signal)
// ----------------------------------------------------------------------

// A story "succeeded" if it reached DONE / completed. Anything escalated /
// failed / stopped is a failure. In-flight (running/queued/...) → null.
function deriveSucceeded(story = {}) {
  const phase = story.current_phase;
  const status = story.status;
  if (status === 'completed' || phase === 'DONE') return true;
  if (status === 'failed' || phase === 'ESCALATED' || status === 'stopped' || phase === 'STOPPED') return false;
  return null;
}

// Phase 11-D seed: back-compute "real" difficulty from what it actually
// took. Many retries OR high cost ⇒ it was harder than a trivial/easy call.
// Coarse on purpose; refined later with calibration data.
function deriveActualDifficulty({ fix_loop_attempts = 0, executor_cost_usd = 0, succeeded } = {}) {
  if (succeeded === false) return 'hard'; // failed outright ⇒ at least hard for the chosen model
  if (fix_loop_attempts >= 3 || executor_cost_usd >= 0.40) return 'hard';
  if (fix_loop_attempts >= 1 || executor_cost_usd >= 0.10) return 'medium';
  if (executor_cost_usd >= 0.02) return 'easy';
  return 'trivial';
}

// Pull the cost-ledger rows for this story and split planner vs executor.
function summarizeCost(ledgerEntries = [], story = {}) {
  const plannerModel = story.planner_model;
  let planner_cost_usd = 0;
  let executor_cost_usd = 0;
  const byModel = {};
  for (const e of ledgerEntries) {
    const cost = Number(e.cost_usd) || 0;
    byModel[e.model] = (byModel[e.model] || 0) + cost;
    if (plannerModel && e.model === plannerModel && e.story_id == null) planner_cost_usd += cost;
    else executor_cost_usd += cost;
  }
  return { planner_cost_usd, executor_cost_usd, byModel };
}

// Deterministic UUIDv5 so re-runs upsert instead of double-counting.
const RALPH_UUID_NAMESPACE = '6f9e4d2a-0c3b-5e7f-8a1d-2b3c4d5e6f70';
function executionId({ story_id, attempt_number, model, role = 'executor' }) {
  const name = `${story_id}|${attempt_number}|${model}|${role}`;
  const hash = crypto.createHash('sha1').update(RALPH_UUID_NAMESPACE + name).digest('hex');
  // Format 16 bytes of the hash as a v5-shaped UUID.
  const h = hash.slice(0, 32).split('');
  h[12] = '5'; // version
  const variant = (parseInt(h[16], 16) & 0x3 | 0x8).toString(16);
  h[16] = variant;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// ----------------------------------------------------------------------
// Build the full normalized record
// ----------------------------------------------------------------------

function buildOutcomeRecord({ story = {}, ledgerEntries = [], now = new Date() }) {
  const context = extractContext(story);
  const succeeded = deriveSucceeded(story);
  const { planner_cost_usd, executor_cost_usd, byModel } = summarizeCost(ledgerEntries, story);
  const fix_loop_attempts = Number(story.attempts) || 0;
  const actual_difficulty = succeeded == null ? null : deriveActualDifficulty({ fix_loop_attempts, executor_cost_usd, succeeded });

  // One execution row per distinct executor model the story used.
  const executions = Object.keys(byModel).length
    ? Object.entries(byModel).map(([model, cost]) => {
        const role = model === story.planner_model ? 'planner' : 'executor';
        return {
          id: executionId({ story_id: story.story_id, attempt_number: fix_loop_attempts, model, role }),
          story_id: story.story_id,
          attempt_number: fix_loop_attempts,
          model,
          role,
          succeeded: role === 'executor' ? succeeded : null,
          fix_loop_attempts,
          cost_usd: Math.round(cost * 1e6) / 1e6,
          failure_class: succeeded === false ? (story.blocked_reason || 'unknown') : null,
          routing_source: story.routing_source || null,
          status: succeeded == null ? 'running' : succeeded ? 'succeeded' : 'failed',
          completed_at: succeeded == null ? null : now.toISOString()
        };
      })
    : [{
        // No ledger rows (e.g. local smoke) — still record the executor pick.
        id: executionId({ story_id: story.story_id, attempt_number: fix_loop_attempts, model: story.executor_model || 'unknown', role: 'executor' }),
        story_id: story.story_id,
        attempt_number: fix_loop_attempts,
        model: story.executor_model || 'unknown',
        role: 'executor',
        succeeded,
        fix_loop_attempts,
        cost_usd: Math.round(executor_cost_usd * 1e6) / 1e6,
        failure_class: succeeded === false ? (story.blocked_reason || 'unknown') : null,
        routing_source: story.routing_source || null,
        status: succeeded == null ? 'running' : succeeded ? 'succeeded' : 'failed',
        completed_at: succeeded == null ? null : now.toISOString()
      }];

  return {
    task: {
      ...context,
      actual_difficulty,
      created_at: story.created_at || now.toISOString(),
      updated_at: now.toISOString()
    },
    executions,
    summary: { succeeded, planner_cost_usd, executor_cost_usd, fix_loop_attempts }
  };
}

// ----------------------------------------------------------------------
// Sinks
// ----------------------------------------------------------------------

function localSink({ rootDir, record, now = new Date() }) {
  const ralphDir = path.join(rootDir, '.ralph');
  if (!fs.existsSync(ralphDir)) fs.mkdirSync(ralphDir, { recursive: true });
  const outPath = path.join(ralphDir, 'outcomes.jsonl');
  const line = JSON.stringify({ at: now.toISOString(), ...record }) + '\n';
  fs.appendFileSync(outPath, line, 'utf8');
  return { ok: true, sink: 'local', path: outPath };
}

function selectSink(env = process.env) {
  return String(env.RALPH_OUTCOME_SINK || 'local').toLowerCase();
}

// Record a finished story. `writeSupabase` is injectable for tests / for
// the future supabase sink; when sink=supabase and no writer is provided
// we degrade to local + flag it (never silently drop data).
function recordTaskOutcome({ rootDir, story, ledgerEntries = [], env = process.env, now = new Date(), writeSupabase } = {}) {
  if (!rootDir || !story || !story.story_id) {
    return { ok: false, reason: 'rootDir_and_story_required' };
  }
  const record = buildOutcomeRecord({ story, ledgerEntries, now });
  const sink = selectSink(env);

  if (sink === 'supabase') {
    if (typeof writeSupabase === 'function') {
      try {
        writeSupabase(record);
        return { ok: true, sink: 'supabase', record };
      } catch (err) {
        // never drop data: fall back to local and report (spread local
        // first so our explicit sink label wins over localSink's).
        const local = localSink({ rootDir, record, now });
        return { ...local, ok: true, sink: 'local_fallback', record, supabase_error: err.message };
      }
    }
    const local = localSink({ rootDir, record, now });
    return { ...local, ok: true, sink: 'local_fallback', record, reason: 'supabase_writer_not_provided' };
  }

  const local = localSink({ rootDir, record, now });
  return { ...local, ok: true, sink: 'local', record };
}

// Read the cost-ledger rows for one story (the per-attempt model spend) so the
// live loop can record a finished story without the caller assembling them.
function readLedgerEntries({ rootDir, story_id } = {}) {
  if (!rootDir || !story_id) return [];
  const p = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.story_id === story_id) out.push(e);
    } catch { /* skip malformed */ }
  }
  return out;
}

// Convenience for the live loop terminal hook: pull the ledger and record.
function recordStoryOutcome({ rootDir, story, env = process.env, now = new Date(), writeSupabase } = {}) {
  if (!rootDir || !story || !story.story_id) return { ok: false, reason: 'rootDir_and_story_required' };
  const ledgerEntries = readLedgerEntries({ rootDir, story_id: story.story_id });
  return recordTaskOutcome({ rootDir, story, ledgerEntries, env, now, writeSupabase });
}

module.exports = {
  KNOWN_DIFFICULTIES,
  inferLanguage,
  inferTaskKind,
  contextBucket,
  extractContext,
  deriveSucceeded,
  deriveActualDifficulty,
  summarizeCost,
  executionId,
  buildOutcomeRecord,
  localSink,
  selectSink,
  readLedgerEntries,
  recordStoryOutcome,
  recordTaskOutcome
};
