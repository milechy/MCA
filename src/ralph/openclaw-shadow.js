const fs = require('node:fs');
const path = require('node:path');

// Phase B2 — shadow-compare the OpenClaw (NemoClaw/OpenShell) execution backend
// against the production opencode-kimi dispatcher for the SAME task, WITHOUT
// affecting production merges. This is the data-gathering step behind the
// staged migration: Phase C flips the default to OpenClaw only once the shadow
// log shows it matches opencode-kimi on valid-patch rate (and is competitive on
// latency/cost). Until then the loop keeps merging opencode-kimi's output and
// OpenClaw just runs alongside for comparison.
//
// Pure orchestration + injected runners and clock so tests never touch the
// sandbox, OpenRouter, or the wall clock.

// Normalize whatever a backend returns into one comparable shape. Both
// dispatchers expose `ok` + `candidate_patch_path`; only opencode-kimi carries
// a per-call cost, so cost may be null for OpenClaw (its inference is billed at
// the sandbox/gemini layer, not per dispatch).
function normalizeBackendResult(result = {}, { duration_ms = null } = {}) {
  return {
    ok: result.ok === true,
    candidate_patch_path: result.candidate_patch_path || null,
    reason: result.reason || null,
    model: result.executor_model || result.model || null,
    cost_usd: typeof result.cost_usd === 'number'
      ? result.cost_usd
      : (typeof result.estimated_cost_usd === 'number' ? result.estimated_cost_usd : null),
    duration_ms,
    execution_connected: result.execution_connected === true
  };
}

function compareBackends(openclaw, kimi) {
  const ocOk = openclaw.ok === true;
  const kimiOk = kimi.ok === true;
  let agreement;
  if (ocOk && kimiOk) agreement = 'both_valid';
  else if (ocOk) agreement = 'only_openclaw';
  else if (kimiOk) agreement = 'only_kimi';
  else agreement = 'neither';

  let faster = 'unknown';
  if (openclaw.duration_ms != null && kimi.duration_ms != null) {
    if (openclaw.duration_ms < kimi.duration_ms) faster = 'openclaw';
    else if (kimi.duration_ms < openclaw.duration_ms) faster = 'kimi';
    else faster = 'tie';
  }

  let cheaper = 'unknown';
  if (openclaw.cost_usd != null && kimi.cost_usd != null) {
    if (openclaw.cost_usd < kimi.cost_usd) cheaper = 'openclaw';
    else if (kimi.cost_usd < openclaw.cost_usd) cheaper = 'kimi';
    else cheaper = 'tie';
  }

  return {
    both_produced_valid_patch: ocOk && kimiOk,
    agreement,
    faster,
    cheaper,
    openclaw_ok: ocOk,
    kimi_ok: kimiOk
  };
}

// Run BOTH backends for one task and return a structured comparison. Runners
// are injected (defaults wired by the CLI) and are synchronous (both real
// dispatchers are spawnSync-based). `clock` returns ms; injectable for tests.
function runShadowComparison({
  rootDir = process.cwd(),
  task,
  requested_paths = [],
  story_id = null,
  env = process.env,
  runOpenClaw,
  runOpenCodeKimi,
  clock = () => Date.now()
} = {}) {
  if (!task) return { ok: false, reason: 'task_required' };
  if (typeof runOpenClaw !== 'function' || typeof runOpenCodeKimi !== 'function') {
    return { ok: false, reason: 'runners_required' };
  }

  const time = (fn) => {
    const start = clock();
    let result;
    let error = null;
    try { result = fn(); } catch (e) { error = e; result = { ok: false, reason: String((e && e.message) || e) }; }
    return { result, duration_ms: clock() - start, error };
  };

  const oc = time(() => runOpenClaw({ rootDir, task, requested_paths, env }));
  const kimi = time(() => runOpenCodeKimi({ rootDir, task, requested_paths, env }));

  const openclaw = normalizeBackendResult(oc.result, { duration_ms: oc.duration_ms });
  const opencode_kimi = normalizeBackendResult(kimi.result, { duration_ms: kimi.duration_ms });

  return {
    ok: true,
    story_id,
    task_preview: String(task).slice(0, 200),
    requested_paths,
    openclaw,
    opencode_kimi,
    comparison: compareBackends(openclaw, opencode_kimi)
  };
}

// Append a comparison to the shadow log. Best-effort; never throws into a run.
function recordShadowComparison({ rootDir = process.cwd(), record, now = new Date() } = {}) {
  if (!record) return { ok: false, reason: 'record_required' };
  try {
    const dir = path.join(rootDir, '.ralph');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'shadow-execution.jsonl'),
      JSON.stringify({ at: now.toISOString(), ...record }) + '\n',
      'utf8'
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

// Aggregate the shadow log into a verdict the Phase C migration can read:
// over N comparisons, how often did OpenClaw produce a valid patch vs kimi,
// and is it competitive on latency?
function summarizeShadowLog(records = []) {
  const n = records.length;
  if (!n) return { samples: 0, verdict: 'no_data' };
  let bothValid = 0, openclawValid = 0, kimiValid = 0, openclawFaster = 0;
  for (const r of records) {
    const c = r.comparison || {};
    if (r.openclaw && r.openclaw.ok) openclawValid += 1;
    if (r.opencode_kimi && r.opencode_kimi.ok) kimiValid += 1;
    if (c.both_produced_valid_patch) bothValid += 1;
    if (c.faster === 'openclaw') openclawFaster += 1;
  }
  const openclawRate = openclawValid / n;
  const kimiRate = kimiValid / n;
  // Migration-ready heuristic: OpenClaw matches or beats kimi's valid-patch
  // rate over a meaningful sample. The operator still makes the call.
  const verdict = n < 5 ? 'insufficient_samples'
    : openclawRate >= kimiRate ? 'openclaw_competitive'
      : 'openclaw_behind';
  return {
    samples: n,
    openclaw_valid_rate: Number(openclawRate.toFixed(3)),
    kimi_valid_rate: Number(kimiRate.toFixed(3)),
    both_valid: bothValid,
    openclaw_faster_count: openclawFaster,
    verdict
  };
}

module.exports = {
  normalizeBackendResult,
  compareBackends,
  runShadowComparison,
  recordShadowComparison,
  summarizeShadowLog
};
