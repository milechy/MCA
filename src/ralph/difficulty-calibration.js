const fs = require('node:fs');
const path = require('node:path');

// Phase 11-D: difficulty calibration.
//
// The Gemini + Perplexity cross-checks (§8.5) flagged that the REAL weak
// link isn't the routing table — it's the planner's one-shot difficulty
// guess (DeepSeek V3). If the planner systematically under-estimates, every
// downstream routing decision starts from a wrong tier. So before (or
// instead of) learning the routing, calibrate the difficulty signal.
//
// This module compares the planner's predicted_difficulty against the
// actual_difficulty back-computed from outcomes (retries/cost, recorded by
// 11-A), builds a confusion matrix, detects systematic bias per class, and
// emits correction few-shot examples the planner prompt can be seeded with.
//
// Perplexity's judge-calibration caution is honored: we do NOT trust a
// single mismatch. Bias is only reported per-class with a minimum sample
// count, and the recommendation is a *prompt correction*, never an
// automatic silent re-label.

const ORDER = ['trivial', 'easy', 'medium', 'hard', 'architectural'];

function rank(difficulty) {
  const i = ORDER.indexOf(String(difficulty || '').toLowerCase());
  return i === -1 ? null : i;
}

function readOutcomes(rootDir) {
  const p = path.join(rootDir, '.ralph', 'outcomes.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// latest record per story wins (append-only file)
function dedupeLatest(outcomes) {
  const m = new Map();
  for (const o of outcomes) {
    const sid = o.task && o.task.story_id;
    if (sid) m.set(sid, o);
  }
  return [...m.values()];
}

// Build (predicted, actual) pairs from outcomes that have both.
function pairs(outcomes) {
  return dedupeLatest(outcomes)
    .map((o) => o.task || {})
    .filter((t) => t.predicted_difficulty && t.actual_difficulty)
    .map((t) => ({
      story_id: t.story_id,
      predicted: String(t.predicted_difficulty).toLowerCase(),
      actual: String(t.actual_difficulty).toLowerCase()
    }))
    .filter((p) => rank(p.predicted) != null && rank(p.actual) != null);
}

// Confusion matrix: matrix[predicted][actual] = count.
function confusionMatrix(ps) {
  const m = {};
  for (const d of ORDER) { m[d] = {}; for (const a of ORDER) m[d][a] = 0; }
  for (const p of ps) m[p.predicted][p.actual] += 1;
  return m;
}

// Per predicted-class bias: mean signed rank error (actual - predicted).
// Positive ⇒ planner UNDER-estimates (real tasks harder than predicted).
// Negative ⇒ planner OVER-estimates.
function classBias(ps, { minSamples = 3 } = {}) {
  const byPred = {};
  for (const p of ps) {
    byPred[p.predicted] = byPred[p.predicted] || [];
    byPred[p.predicted].push(rank(p.actual) - rank(p.predicted));
  }
  const out = {};
  for (const [pred, errs] of Object.entries(byPred)) {
    const n = errs.length;
    const mean = errs.reduce((a, b) => a + b, 0) / n;
    const accurate = errs.filter((e) => e === 0).length;
    out[pred] = {
      samples: n,
      accuracy: Math.round((accurate / n) * 1000) / 1000,
      mean_rank_error: Math.round(mean * 1000) / 1000,
      direction: mean > 0.25 ? 'under_estimates' : mean < -0.25 ? 'over_estimates' : 'calibrated',
      low_confidence: n < minSamples
    };
  }
  return out;
}

// Turn detected bias into a single calibration recommendation per class:
// if the planner consistently under/over-estimates a class, suggest the
// adjusted target tier.
function calibrationAdjustments(bias) {
  const adj = {};
  for (const [pred, b] of Object.entries(bias)) {
    if (b.direction === 'calibrated') continue;
    const shift = Math.round(b.mean_rank_error);
    if (shift === 0) continue;
    const targetIdx = Math.min(ORDER.length - 1, Math.max(0, rank(pred) + shift));
    adj[pred] = {
      from: pred,
      suggested: ORDER[targetIdx],
      direction: b.direction,
      mean_rank_error: b.mean_rank_error,
      samples: b.samples,
      low_confidence: b.low_confidence,
      note: b.low_confidence
        ? `planner ${b.direction} '${pred}' but only ${b.samples} samples — collect more before acting`
        : `planner ${b.direction} '${pred}' tasks; consider treating them as '${ORDER[targetIdx]}'`
    };
  }
  return adj;
}

// Few-shot correction examples the planner prompt can be seeded with: the
// worst mis-estimates (largest |rank error|), as concrete "you said X, it
// was actually Y" lessons. This is the prompt-seed, NOT an auto-relabel.
function correctionExamples(ps, outcomes, { limit = 5 } = {}) {
  const byStory = {};
  for (const o of dedupeLatest(outcomes)) {
    if (o.task && o.task.story_id) byStory[o.task.story_id] = o.task;
  }
  return ps
    .map((p) => ({ ...p, err: Math.abs(rank(p.actual) - rank(p.predicted)) }))
    .filter((p) => p.err > 0)
    .sort((a, b) => b.err - a.err)
    .slice(0, limit)
    .map((p) => ({
      story_id: p.story_id,
      predicted: p.predicted,
      actual: p.actual,
      task_kind: (byStory[p.story_id] || {}).task_kind || null,
      context_bucket: (byStory[p.story_id] || {}).context_bucket || null,
      lesson: `Predicted '${p.predicted}' but it behaved like '${p.actual}'. For similar ${(byStory[p.story_id] || {}).task_kind || 'tasks'}, lean toward '${p.actual}'.`
    }));
}

function buildCalibrationReport(rootDir, { minSamples = 3, limit = 5 } = {}) {
  const outcomes = readOutcomes(rootDir);
  const ps = pairs(outcomes);
  const overall_accuracy = ps.length ? Math.round((ps.filter((p) => p.predicted === p.actual).length / ps.length) * 1000) / 1000 : 0;
  const bias = classBias(ps, { minSamples });
  return {
    total_pairs: ps.length,
    overall_accuracy,
    confusion_matrix: confusionMatrix(ps),
    class_bias: bias,
    adjustments: calibrationAdjustments(bias),
    correction_examples: correctionExamples(ps, outcomes, { limit })
  };
}

function formatCalibrationReport(report) {
  const out = [`# Difficulty calibration (${report.total_pairs} pairs, overall accuracy ${report.overall_accuracy})`];
  out.push('\n## Per-class bias (predicted → actual rank error)');
  out.push('predicted | samples | accuracy | mean_err | direction');
  out.push('--- | --- | --- | --- | ---');
  for (const [pred, b] of Object.entries(report.class_bias)) {
    out.push(`${pred} | ${b.samples} | ${b.accuracy} | ${b.mean_rank_error} | ${b.direction}${b.low_confidence ? ' ⚠' : ''}`);
  }
  out.push('\n## Suggested calibration adjustments');
  const adj = Object.values(report.adjustments);
  if (!adj.length) out.push('(none — planner is calibrated within tolerance, or insufficient data)');
  for (const a of adj) out.push(`- ${a.note}`);
  out.push('\n## Worst mis-estimates (planner prompt few-shot seed)');
  if (!report.correction_examples.length) out.push('(none)');
  for (const e of report.correction_examples) out.push(`- ${e.lesson} [${e.story_id}]`);
  return out.join('\n');
}

module.exports = {
  ORDER,
  rank,
  readOutcomes,
  dedupeLatest,
  pairs,
  confusionMatrix,
  classBias,
  calibrationAdjustments,
  correctionExamples,
  buildCalibrationReport,
  formatCalibrationReport
};
