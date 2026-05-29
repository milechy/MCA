const fs = require('node:fs');
const path = require('node:path');

// Phase 11-B: routing statistics.
//
// Answers "for a given difficulty (and context bucket), which model has the
// best success-rate / cost-per-success?" — the data-informed replacement
// for eyeballing DIFFICULTY_TIER_MODELS (which is how Qwen→Haiku got swapped
// by hand in PR #180). Mirrors the success_rate_by_model SQL view from the
// 11-A migration, but runs on the local .ralph/outcomes.jsonl so it works
// today without Supabase.
//
// Pure aggregation core (testable) + a thin file-reading wrapper.

function readOutcomes(rootDir) {
  const p = path.join(rootDir, '.ralph', 'outcomes.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

// Idempotency at read time: outcomes.jsonl is append-only, so a re-recorded
// story appears multiple times. Keep only the LAST record per story_id
// (latest state wins) before aggregating.
function dedupeLatest(outcomes) {
  const byStory = new Map();
  for (const o of outcomes) {
    const sid = o.task && o.task.story_id;
    if (!sid) continue;
    byStory.set(sid, o); // later lines overwrite earlier
  }
  return [...byStory.values()];
}

function round(n, d = 4) {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
}

// Aggregate executor rows by a key function.
function aggregate(outcomes, keyOf) {
  const groups = new Map();
  for (const o of dedupeLatest(outcomes)) {
    const execs = (o.executions || []).filter((e) => e.role === 'executor' && e.status !== 'running');
    for (const e of execs) {
      const key = keyOf(o, e);
      if (!groups.has(key)) {
        groups.set(key, { key, executions: 0, successes: 0, total_cost_usd: 0, fix_loops: 0 });
      }
      const g = groups.get(key);
      g.executions += 1;
      if (e.succeeded === true) g.successes += 1;
      g.total_cost_usd += Number(e.cost_usd) || 0;
      g.fix_loops += Number(e.fix_loop_attempts) || 0;
    }
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    executions: g.executions,
    successes: g.successes,
    success_rate: g.executions ? round(g.successes / g.executions, 3) : 0,
    total_cost_usd: round(g.total_cost_usd, 4),
    cost_per_success_usd: g.successes ? round(g.total_cost_usd / g.successes, 4) : null,
    avg_fix_loops: g.executions ? round(g.fix_loops / g.executions, 2) : 0
  }));
}

function statsByDifficultyModel(outcomes) {
  return aggregate(outcomes, (o, e) => `${o.task.difficulty || 'unknown'} | ${e.model}`)
    .sort((a, b) => a.key.localeCompare(b.key) || b.success_rate - a.success_rate);
}

function statsByContextBucket(outcomes) {
  return aggregate(outcomes, (o, e) => `${o.task.context_bucket || 'unknown'} | ${e.model}`)
    .sort((a, b) => a.key.localeCompare(b.key));
}

// For each difficulty, which model is the recommended pick by cost-per-
// success (lowest), requiring a minimum sample size to avoid noise.
function recommendByDifficulty(outcomes, { minSamples = 2 } = {}) {
  const byDiff = new Map();
  for (const row of statsByDifficultyModel(outcomes)) {
    const [difficulty, model] = row.key.split(' | ');
    if (!byDiff.has(difficulty)) byDiff.set(difficulty, []);
    byDiff.get(difficulty).push({ model, ...row });
  }
  const out = {};
  for (const [difficulty, rows] of byDiff) {
    const eligible = rows.filter((r) => r.executions >= minSamples && r.cost_per_success_usd != null);
    const pool = eligible.length ? eligible : rows.filter((r) => r.cost_per_success_usd != null);
    if (!pool.length) { out[difficulty] = { model: null, reason: 'no_successful_samples' }; continue; }
    // best = highest success_rate, tie-break by lowest cost_per_success
    pool.sort((a, b) => b.success_rate - a.success_rate || a.cost_per_success_usd - b.cost_per_success_usd);
    const best = pool[0];
    out[difficulty] = {
      model: best.model,
      success_rate: best.success_rate,
      cost_per_success_usd: best.cost_per_success_usd,
      samples: best.executions,
      low_confidence: best.executions < minSamples
    };
  }
  return out;
}

function formatTable(rows, title) {
  const lines = [`\n## ${title}`];
  if (!rows.length) { lines.push('(no data)'); return lines.join('\n'); }
  lines.push('key | exec | succ | rate | total$ | $/succ | avgFix');
  lines.push('--- | ---- | ---- | ---- | ------ | ------ | ------');
  for (const r of rows) {
    lines.push([
      r.key,
      r.executions,
      r.successes,
      r.success_rate,
      r.total_cost_usd,
      r.cost_per_success_usd == null ? '—' : r.cost_per_success_usd,
      r.avg_fix_loops
    ].join(' | '));
  }
  return lines.join('\n');
}

function buildReport(rootDir, { minSamples = 2 } = {}) {
  const outcomes = readOutcomes(rootDir);
  const deduped = dedupeLatest(outcomes);
  const byDM = statsByDifficultyModel(outcomes);
  const byCB = statsByContextBucket(outcomes);
  const rec = recommendByDifficulty(outcomes, { minSamples });
  return {
    total_stories: deduped.length,
    by_difficulty_model: byDM,
    by_context_bucket: byCB,
    recommendations: rec
  };
}

function formatReport(report) {
  const parts = [`# Routing stats (${report.total_stories} stories)`];
  parts.push(formatTable(report.by_difficulty_model, 'By difficulty × model'));
  parts.push(formatTable(report.by_context_bucket, 'By context bucket × model'));
  parts.push('\n## Data-informed recommendation per difficulty');
  parts.push('(vs the hand-set DIFFICULTY_TIER_MODELS ladder)');
  for (const [diff, r] of Object.entries(report.recommendations)) {
    if (!r.model) { parts.push(`- ${diff}: ${r.reason}`); continue; }
    const conf = r.low_confidence ? ' ⚠low-confidence' : '';
    parts.push(`- ${diff} → ${r.model} (rate=${r.success_rate}, $/succ=${r.cost_per_success_usd}, n=${r.samples})${conf}`);
  }
  return parts.join('\n');
}

module.exports = {
  readOutcomes,
  dedupeLatest,
  aggregate,
  statsByDifficultyModel,
  statsByContextBucket,
  recommendByDifficulty,
  buildReport,
  formatReport,
  formatTable
};
