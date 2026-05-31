const { MODEL_PRICING, pricingForModel, estimateCostUsd } = require('./kimi-cost-tracker');

// Phase 3 #4/#5 set Kimi K2.6 as the workhorse fallback. Phase 8 #4 keeps
// that posture but adds a difficulty-aware tier ladder ABOVE it: when the
// planner classifies a story as medium/hard/architectural, route to a
// model that can actually handle that complexity rather than wasting
// Kimi attempts on tasks it cannot complete. Trivial/easy still goes to
// Kimi by default (cost wins). Operator can override per-story via
// story.executor_model, which always wins over the tier ladder.
const FALLBACK_EXECUTOR_MODEL = 'openrouter/moonshotai/kimi-k2.6';

// Phase 8 #4: difficulty → executor model mapping. Each tier's preferred
// model must be in MODEL_PRICING (the allowlist); if missing, we fall back
// to Kimi with reason='difficulty_tier_model_missing' so cost-tracking and
// safety checks still apply. The tier ladder is intentionally short — four
// tiers covering the planner's four difficulty values.
const DIFFICULTY_TIER_MODELS = Object.freeze({
  trivial: 'openrouter/moonshotai/kimi-k2.6',
  easy: 'openrouter/moonshotai/kimi-k2.6',
  // Phase 8 #5b: medium was Qwen3-Coder, but the live smoke (#24, 2026-05-27)
  // failed all 3 attempts with `requested_paths_coverage_incomplete`. Qwen
  // wrote source-only output (skipped the requested test file) AND emitted
  // Python-dict syntax inside a JS module.exports — destroying the original
  // export shape. Cost wasted: $0.103 across 3 retries. Replacing with
  // Claude Haiku 4.5 ($1/$5 per 1M) until a better-priced model proves
  // multi-file MODIFY EXISTING discipline in a live smoke. Qwen3-Coder is
  // kept in MODEL_PRICING so it can still be picked via explicit
  // story.executor_model when an operator wants to experiment.
  medium: 'openrouter/anthropic/claude-haiku-4.5',
  // Claude Sonnet 4.6: Phase 8 #1 (PR #177) proved end-to-end real-work
  // refactor capability at $0.42/PR including planner+reviewer.
  hard: 'openrouter/anthropic/claude-sonnet-4.6',
  // GPT-5: best architectural-judgment model in current OpenRouter catalog.
  // Trigger only when planner explicitly classifies as 'architectural'.
  architectural: 'openrouter/openai/gpt-5'
});

function estimateCostFromContext({ prompt_chars, model, expected_output_chars = 12000 } = {}) {
  const input_tokens = Math.ceil((prompt_chars || 0) / 4);
  const output_tokens = Math.ceil((expected_output_chars || 0) / 4);
  return estimateCostUsd({ input_tokens, output_tokens, model });
}

// Phase 8 #4: pure helper exposed for tests. Maps a story.difficulty string
// to the preferred executor model. Unknown / missing difficulty returns
// null, leaving the existing Kimi-fallback path responsible.
function modelForDifficulty(difficulty) {
  if (!difficulty || typeof difficulty !== 'string') return null;
  const key = difficulty.toLowerCase().trim();
  return DIFFICULTY_TIER_MODELS[key] || null;
}

// Phase A: consult the NemoClaw brain when it has a richer signal than the
// static ladder — a classifier reading, prior outcomes to learn from, or a
// retry to escalate. Plain first-attempt calls with no extra signal keep the
// proven static behavior (and its exact contract) untouched, so this is
// backward-compatible while being on by default. Returns null to defer to the
// static ladder. Brain + routing-stats are required lazily to avoid a require
// cycle (nemoclaw-brain depends on this module's FALLBACK_EXECUTOR_MODEL).
function tryBrain({ story = {}, env = process.env, rootDir, prompt_chars = 0 } = {}) {
  if ((env.RALPH_BRAIN || 'on') === 'off') return null;
  const classifierSignal = story.classifier_signal || null;
  const attempt = Number(story.attempt_number) > 0
    ? Number(story.attempt_number)
    : (Array.isArray(story.repair_history) ? story.repair_history.length : 0);
  const lastFailureClass = story.last_failure_class || story.blocked_reason || null;

  let outcomes = [];
  if (rootDir) {
    try { outcomes = require('./routing-stats').readOutcomes(rootDir); } catch { outcomes = []; }
  }
  const hasLearnable = outcomes.length > 0 && Boolean(story.context_bucket);

  // Only engage when the brain can add something beyond the static ladder.
  if (!classifierSignal && attempt === 0 && !hasLearnable) return null;

  const { selectModel, recordDecision } = require('./nemoclaw-brain');
  const decision = selectModel({
    story, classifierSignal, outcomes, attempt, lastFailureClass,
    spentUsd: Number(story.spent_usd) || 0, env
  });
  if (rootDir) recordDecision({ rootDir, story, decision });
  return {
    ok: true,
    executor_model: decision.model,
    estimated_cost_usd: estimateCostFromContext({ prompt_chars, model: decision.model }),
    reason: `nemoclaw_${decision.source}`,
    fallback_applied: decision.fallback_applied,
    routing_source: `nemoclaw_${decision.source}`,
    difficulty_tier: decision.tier == null ? null : String(decision.tier),
    brain_rationale: decision.rationale,
    escalate_to_human: decision.escalate_to_human,
    task_type: decision.task_type,
    complexity: decision.complexity
  };
}

function routeExecutor({ story, env = process.env, rootDir, prompt_chars = 0 } = {}) {
  const brained = tryBrain({ story, env, rootDir, prompt_chars });
  if (brained) return brained;

  const specified = story && story.executor_model;
  let executor_model;
  let fallback_applied = false;
  let reason = null;
  let ok = true;
  // Phase 8 #4: expose the routing decision shape so callers / dashboards
  // can see WHY a model was chosen — explicit, difficulty tier, or fallback.
  let routing_source = 'fallback';
  let difficulty_tier = null;

  if (specified) {
    // Explicit story.executor_model ALWAYS wins. The allowlist still
    // applies — unknown models drop back to Kimi.
    if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, specified)) {
      executor_model = specified;
      fallback_applied = false;
      reason = null;
      routing_source = 'story_explicit';
    } else {
      executor_model = FALLBACK_EXECUTOR_MODEL;
      fallback_applied = true;
      reason = 'executor_model_not_allowed';
      ok = false;
      routing_source = 'fallback_unallowed_explicit';
    }
  } else {
    // Phase 8 #4: no explicit executor — consult the difficulty ladder.
    const difficulty = story && story.difficulty;
    const tiered = modelForDifficulty(difficulty);
    if (tiered) {
      if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, tiered)) {
        executor_model = tiered;
        fallback_applied = false;
        reason = `difficulty_tier_${String(difficulty).toLowerCase().trim()}`;
        routing_source = 'difficulty_tier';
        difficulty_tier = String(difficulty).toLowerCase().trim();
      } else {
        // Tier model exists in the ladder but isn't in MODEL_PRICING — safe
        // fallback to Kimi so we never spawn an unallowlisted model.
        executor_model = FALLBACK_EXECUTOR_MODEL;
        fallback_applied = true;
        reason = 'difficulty_tier_model_missing';
        ok = false;
        routing_source = 'fallback_tier_missing';
        difficulty_tier = String(difficulty).toLowerCase().trim();
      }
    } else {
      // No difficulty AND no explicit executor → original Kimi fallback.
      executor_model = FALLBACK_EXECUTOR_MODEL;
      fallback_applied = true;
      reason = 'no_executor_specified';
      routing_source = 'fallback_no_difficulty';
    }
  }

  const estimated_cost_usd = estimateCostFromContext({ prompt_chars, model: executor_model });

  return {
    ok,
    executor_model,
    estimated_cost_usd,
    reason,
    fallback_applied,
    routing_source,
    difficulty_tier
  };
}

module.exports = {
  FALLBACK_EXECUTOR_MODEL,
  DIFFICULTY_TIER_MODELS,
  estimateCostFromContext,
  modelForDifficulty,
  tryBrain,
  routeExecutor
};
