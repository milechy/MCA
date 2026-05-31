const fs = require('node:fs');
const path = require('node:path');
const { MODEL_PRICING } = require('./kimi-cost-tracker');
const { FALLBACK_EXECUTOR_MODEL } = require('./executor-router');
const { recommendByContextBucket } = require('./routing-stats');

// Phase A — the NemoClaw routing brain.
//
// Turns the (previously static, learning-blind) model choice into a decision
// that combines three signals, in this precedence:
//
//   1. story.executor_model        operator override always wins
//   2. escalation ladder           on retry, climb cheap→expensive by failure
//   3. learned recommendation      confident per-context_bucket history wins
//   4. classifier / difficulty tier cold-start prior (NVIDIA complexity_router)
//
// plus a per-story cost cap that flips `escalate_to_human` so the loop never
// silently burns budget — and, with the Phase 16 hard test gate, never merges
// red. This is the "pick the best LLM for THIS function, and keep climbing
// until tests pass or a human is needed" guarantee.
//
// Pure logic + injected deps (outcomes, classifierSignal, env, rng) so it is
// fully unit-testable without network, disk, or a live classifier.

// Canonical cost-ascending ladder. Values are the same models the static
// DIFFICULTY_TIER_MODELS map uses; kept here as an explicit ordered list so
// escalation has a single source of truth. Filtered against MODEL_PRICING at
// call time so we never route to an unpriced/unallowlisted model.
const ESCALATION_LADDER = Object.freeze([
  'openrouter/moonshotai/kimi-k2.6',     // tier 0  trivial / easy
  'openrouter/anthropic/claude-haiku-4.5', // tier 1  medium
  'openrouter/anthropic/claude-sonnet-4.6', // tier 2  hard
  'openrouter/openai/gpt-5'              // tier 3  architectural
]);

// difficulty string → ladder index, used only when no classifier signal is
// available (the classifier's prompt_complexity_score is preferred because
// the static story.difficulty is frequently mispredicted — see outcomes.jsonl
// predicted=easy / actual=hard).
const DIFFICULTY_TIER_INDEX = Object.freeze({
  trivial: 0, easy: 0, medium: 1, hard: 2, architectural: 3
});

// Failure classes that are transient (provider-side, not the model's fault):
// retry the SAME tier with backoff rather than wasting a pricier model.
const TRANSIENT_FAILURES = Object.freeze(new Set([
  'provider_rate_limited',
  'provider_unavailable',
  'network_timeout'
]));

const DEFAULT_COST_CAP_USD = 0.5;
const DEFAULT_MIN_SAMPLES = 2;
const DEFAULT_SUCCESS_FLOOR = 0.6;

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function allowlistedLadder() {
  return ESCALATION_LADDER.filter((m) => has(MODEL_PRICING, m));
}

// NVIDIA complexity_router policy: overall prompt_complexity_score (0..1) →
// tier. Thresholds chosen so trivial/easy stay on the cheap workhorse and only
// genuinely hard/architectural work pays for the frontier models.
function tierForComplexity(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 0;
  if (s < 0.30) return 0;
  if (s < 0.55) return 1;
  if (s < 0.75) return 2;
  return 3;
}

function normDifficulty(difficulty) {
  return String(difficulty || '').toLowerCase().trim();
}

function baseTierFor({ classifierSignal, story }) {
  if (classifierSignal && classifierSignal.prompt_complexity_score != null) {
    return { tier: tierForComplexity(classifierSignal.prompt_complexity_score), via: 'classifier_tier' };
  }
  const diff = normDifficulty(story && story.difficulty);
  if (diff && has(DIFFICULTY_TIER_INDEX, diff)) {
    return { tier: DIFFICULTY_TIER_INDEX[diff], via: 'difficulty_tier' };
  }
  return { tier: 0, via: 'cold_start' };
}

// Confident learned pick for this story's context_bucket, or null.
function pickLearned({ outcomes, contextBucket, ladder, minSamples, successFloor }) {
  if (!contextBucket || !Array.isArray(outcomes) || !outcomes.length) return null;
  const recs = recommendByContextBucket(outcomes, { minSamples });
  const rec = recs[contextBucket];
  if (!rec || !rec.model) return null;
  if (rec.low_confidence) return null;
  if ((rec.samples || 0) < minSamples) return null;
  if ((rec.success_rate || 0) < successFloor) return null;
  if (!has(MODEL_PRICING, rec.model)) return null;
  // Only honor a learned pick we can actually place on the ladder (so cost
  // ordering / escalation stays coherent). Off-ladder allowlisted models are
  // still usable but treated as tier of their nearest known cost.
  return { model: rec.model, tier: ladder.indexOf(rec.model), rec };
}

function selectModel({
  story = {},
  classifierSignal = null,
  outcomes = [],
  attempt = 0,
  lastFailureClass = null,
  spentUsd = 0,
  env = process.env,
  minSamples = DEFAULT_MIN_SAMPLES,
  successFloor = DEFAULT_SUCCESS_FLOOR
} = {}) {
  const ladder = allowlistedLadder();
  const top = ladder.length - 1;
  const cost_cap_usd = Number.parseFloat(env.RALPH_STORY_COST_CAP_USD) > 0
    ? Number.parseFloat(env.RALPH_STORY_COST_CAP_USD)
    : DEFAULT_COST_CAP_USD;

  const task_type = classifierSignal && classifierSignal.task_type ? classifierSignal.task_type : null;
  const complexity = classifierSignal && classifierSignal.prompt_complexity_score != null
    ? Number(classifierSignal.prompt_complexity_score)
    : null;

  const base = baseTierFor({ classifierSignal, story });
  const capExceeded = Number(spentUsd) >= cost_cap_usd;

  // 1. Explicit operator override always wins (allowlist still applies).
  const specified = story && story.executor_model;
  if (specified && has(MODEL_PRICING, specified)) {
    return finalize({
      model: specified, source: 'story_explicit', tier: ladder.indexOf(specified),
      task_type, complexity, ladder, cost_cap_usd,
      escalate_to_human: capExceeded,
      rationale: `operator override ${specified}${capExceeded ? ' (cost cap exceeded)' : ''}`
    });
  }

  // 2. Retry → escalation ladder.
  if (attempt > 0) {
    const transient = TRANSIENT_FAILURES.has(lastFailureClass);
    // Non-transient failures climb one rung per attempt; a transient last
    // failure retries without adding a rung (but retains prior escalation).
    const wantedSteps = transient ? Math.max(0, attempt - 1) : attempt;
    const wantedTier = base.tier + wantedSteps;
    const tier = Math.min(wantedTier, top);
    const exhausted = wantedTier > top;
    return finalize({
      model: ladder[tier],
      source: transient ? 'escalated_retry_same_tier' : 'escalated',
      tier, task_type, complexity, ladder, cost_cap_usd,
      escalate_to_human: capExceeded || exhausted,
      rationale: transient
        ? `transient failure (${lastFailureClass}); retry tier ${tier} with backoff`
        : `attempt ${attempt} after ${lastFailureClass || 'failure'}; escalated to tier ${tier}${exhausted ? ' (ladder exhausted → human)' : ''}`
    });
  }

  // 3. First attempt — confident learned pick for this function/bucket wins.
  const learned = pickLearned({
    outcomes, contextBucket: story && story.context_bucket, ladder, minSamples, successFloor
  });
  if (learned) {
    return finalize({
      model: learned.model, source: 'learned',
      tier: learned.tier, task_type, complexity, ladder, cost_cap_usd,
      escalate_to_human: capExceeded,
      rationale: `learned: bucket=${story.context_bucket} rate=${learned.rec.success_rate} n=${learned.rec.samples}`
    });
  }

  // 4. Cold-start prior — classifier complexity tier (preferred) or difficulty.
  return finalize({
    model: ladder[Math.min(base.tier, top)],
    source: base.via,
    tier: Math.min(base.tier, top), task_type, complexity, ladder, cost_cap_usd,
    escalate_to_human: capExceeded,
    rationale: complexity != null
      ? `classifier complexity ${complexity} → tier ${base.tier} (${task_type || 'unknown task'})`
      : `${base.via} → tier ${base.tier}`
  });
}

// Guarantee an allowlisted model and a stable output shape.
function finalize({ model, source, tier, task_type, complexity, ladder, cost_cap_usd, escalate_to_human, rationale }) {
  let chosen = model;
  let fallback_applied = false;
  if (!chosen || !has(MODEL_PRICING, chosen)) {
    chosen = FALLBACK_EXECUTOR_MODEL;
    fallback_applied = true;
  }
  return {
    ok: true,
    model: chosen,
    source,
    task_type: task_type || null,
    complexity: complexity == null ? null : complexity,
    tier: tier == null || tier < 0 ? null : tier,
    ladder,
    cost_cap_usd,
    escalate_to_human: Boolean(escalate_to_human),
    fallback_applied,
    rationale: rationale || source
  };
}

// A8 — append the decision (and the signals behind it) to an audit log so
// operators/dashboards can see WHY each model was chosen, and so the choices
// themselves become future learning data. Best-effort: never throws into the
// hot routing path.
function recordDecision({ rootDir, story = {}, decision = {}, now = new Date() } = {}) {
  if (!rootDir) return { ok: false, reason: 'no_root_dir' };
  try {
    const dir = path.join(rootDir, '.ralph');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      at: now.toISOString(),
      story_id: story.story_id || null,
      context_bucket: story.context_bucket || null,
      model: decision.model,
      source: decision.source,
      tier: decision.tier,
      task_type: decision.task_type,
      complexity: decision.complexity,
      escalate_to_human: decision.escalate_to_human,
      cost_cap_usd: decision.cost_cap_usd,
      rationale: decision.rationale
    }) + '\n';
    fs.appendFileSync(path.join(dir, 'brain-decisions.jsonl'), line, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

module.exports = {
  ESCALATION_LADDER,
  DIFFICULTY_TIER_INDEX,
  TRANSIENT_FAILURES,
  DEFAULT_COST_CAP_USD,
  tierForComplexity,
  baseTierFor,
  pickLearned,
  selectModel,
  recordDecision
};
