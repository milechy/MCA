const { test, expect } = require('@playwright/test');

const {
  FALLBACK_EXECUTOR_MODEL,
  estimateCostFromContext,
  routeExecutor
} = require('../../src/ralph/executor-router');

test('estimateCostFromContext returns a positive number for kimi-k2.6 baseline', () => {
  const cost = estimateCostFromContext({ prompt_chars: 4000, model: 'openrouter/moonshotai/kimi-k2.6' });
  expect(cost).toBeGreaterThan(0);
  expect(cost).toBeLessThan(0.01);
});

test('estimateCostFromContext uses Claude Sonnet pricing for sonnet model', () => {
  const cost = estimateCostFromContext({
    prompt_chars: 4000,
    expected_output_chars: 4000,
    model: 'openrouter/anthropic/claude-sonnet-4.6'
  });
  // 1000 * 0.000003 + 1000 * 0.000015 = 0.018
  expect(cost).toBe(0.018);
});

test('estimateCostFromContext default output is 12000 chars (3000 tokens)', () => {
  const cost = estimateCostFromContext({ prompt_chars: 0, model: 'openrouter/moonshotai/kimi-k2.6' });
  // 0 input + 3000 * 0.0000008 = 0.0024
  expect(cost).toBe(0.0024);
});

test('routeExecutor uses story.executor_model when allowed', () => {
  const result = routeExecutor({ story: { executor_model: 'openrouter/anthropic/claude-sonnet-4.6' } });
  expect(result.ok).toBe(true);
  expect(result.executor_model).toBe('openrouter/anthropic/claude-sonnet-4.6');
  expect(result.fallback_applied).toBe(false);
  expect(result.reason).toBe(null);
});

test('routeExecutor falls back when story.executor_model is unknown', () => {
  const result = routeExecutor({ story: { executor_model: 'some/unknown/model' } });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('executor_model_not_allowed');
  expect(result.executor_model).toBe(FALLBACK_EXECUTOR_MODEL);
  expect(result.fallback_applied).toBe(true);
});

test('routeExecutor falls back when story.executor_model is null', () => {
  const result = routeExecutor({ story: { executor_model: null } });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('no_executor_specified');
  expect(result.executor_model).toBe(FALLBACK_EXECUTOR_MODEL);
  expect(result.fallback_applied).toBe(true);
});

test('routeExecutor falls back when story.executor_model is undefined', () => {
  const result = routeExecutor({ story: {} });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('no_executor_specified');
  expect(result.executor_model).toBe(FALLBACK_EXECUTOR_MODEL);
  expect(result.fallback_applied).toBe(true);
});

test('routeExecutor falls back when story.executor_model is empty string', () => {
  const result = routeExecutor({ story: { executor_model: '' } });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('no_executor_specified');
  expect(result.executor_model).toBe(FALLBACK_EXECUTOR_MODEL);
  expect(result.fallback_applied).toBe(true);
});

test('routeExecutor returns estimated_cost_usd > 0 for non-empty prompt', () => {
  const result = routeExecutor({
    story: { executor_model: 'openrouter/moonshotai/kimi-k2.6' },
    prompt_chars: 4000
  });
  expect(result.estimated_cost_usd).toBeGreaterThan(0);
});

test('routeExecutor with zero prompt_chars still returns a cost > 0 (default output tokens contribute)', () => {
  const result = routeExecutor({
    story: { executor_model: 'openrouter/moonshotai/kimi-k2.6' },
    prompt_chars: 0
  });
  expect(result.estimated_cost_usd).toBeGreaterThan(0);
});

// ============================================================
// Phase 8 #4: difficulty-based executor router
// ============================================================
//
// When no explicit story.executor_model is set, route by story.difficulty:
//   trivial / easy → Kimi K2.6 (cost wins)
//   medium → Qwen3-Coder (mid-tier)
//   hard → Claude Sonnet 4.6 (Phase 8 #1 proved $0.42/PR for real refactor)
//   architectural → GPT-5 (best architectural judgment)
//
// Explicit story.executor_model ALWAYS wins. Tier models that aren't in
// MODEL_PRICING fall back to Kimi with reason='difficulty_tier_model_missing'.

const { modelForDifficulty, DIFFICULTY_TIER_MODELS } = require('../../src/ralph/executor-router');

test('Phase 8 #4: modelForDifficulty maps each canonical difficulty to its tier model', () => {
  expect(modelForDifficulty('trivial')).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(modelForDifficulty('easy')).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(modelForDifficulty('medium')).toBe('openrouter/qwen/qwen3-coder');
  expect(modelForDifficulty('hard')).toBe('openrouter/anthropic/claude-sonnet-4.6');
  expect(modelForDifficulty('architectural')).toBe('openrouter/openai/gpt-5');
});

test('Phase 8 #4: modelForDifficulty handles case-insensitive + trim, returns null for unknown', () => {
  expect(modelForDifficulty('  HARD  ')).toBe('openrouter/anthropic/claude-sonnet-4.6');
  expect(modelForDifficulty('Easy')).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(modelForDifficulty('LEGENDARY')).toBe(null);
  expect(modelForDifficulty(null)).toBe(null);
  expect(modelForDifficulty(undefined)).toBe(null);
  expect(modelForDifficulty('')).toBe(null);
  expect(modelForDifficulty(42)).toBe(null);  // non-string
});

test('Phase 8 #4: DIFFICULTY_TIER_MODELS is frozen so future code cannot mutate the ladder', () => {
  expect(Object.isFrozen(DIFFICULTY_TIER_MODELS)).toBe(true);
});

test('Phase 8 #4: routeExecutor uses difficulty tier when no explicit executor_model', () => {
  const r = routeExecutor({
    story: { difficulty: 'hard' }, // no executor_model
    prompt_chars: 100
  });
  expect(r.ok).toBe(true);
  expect(r.executor_model).toBe('openrouter/anthropic/claude-sonnet-4.6');
  expect(r.fallback_applied).toBe(false);
  expect(r.routing_source).toBe('difficulty_tier');
  expect(r.difficulty_tier).toBe('hard');
  expect(r.reason).toBe('difficulty_tier_hard');
});

test('Phase 8 #4: routeExecutor routes trivial/easy to Kimi via tier (not via no-difficulty fallback)', () => {
  for (const difficulty of ['trivial', 'easy']) {
    const r = routeExecutor({ story: { difficulty }, prompt_chars: 100 });
    expect(r.executor_model).toBe('openrouter/moonshotai/kimi-k2.6');
    expect(r.routing_source).toBe('difficulty_tier');
    expect(r.difficulty_tier).toBe(difficulty);
    // tier-routing to Kimi is the intended path, not a fallback.
    expect(r.fallback_applied).toBe(false);
    expect(r.ok).toBe(true);
  }
});

test('Phase 8 #4: routeExecutor routes medium and architectural to their tier models', () => {
  const medium = routeExecutor({ story: { difficulty: 'medium' }, prompt_chars: 50 });
  expect(medium.executor_model).toBe('openrouter/qwen/qwen3-coder');
  expect(medium.routing_source).toBe('difficulty_tier');

  const arch = routeExecutor({ story: { difficulty: 'architectural' }, prompt_chars: 50 });
  expect(arch.executor_model).toBe('openrouter/openai/gpt-5');
  expect(arch.routing_source).toBe('difficulty_tier');
});

test('Phase 8 #4: routeExecutor — story.executor_model ALWAYS wins over difficulty tier', () => {
  // Story says hard (would route to Sonnet) but operator overrode with Kimi.
  const r = routeExecutor({
    story: {
      executor_model: 'openrouter/moonshotai/kimi-k2.6',
      difficulty: 'hard'
    },
    prompt_chars: 50
  });
  expect(r.executor_model).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(r.routing_source).toBe('story_explicit');
  expect(r.fallback_applied).toBe(false);
});

test('Phase 8 #4: routeExecutor — unknown difficulty falls through to no-difficulty Kimi path', () => {
  const r = routeExecutor({
    story: { difficulty: 'godmode' }, // not in the ladder
    prompt_chars: 50
  });
  expect(r.executor_model).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(r.routing_source).toBe('fallback_no_difficulty');
  expect(r.fallback_applied).toBe(true);
  expect(r.reason).toBe('no_executor_specified');
});

test('Phase 8 #4: routeExecutor without story falls through to Kimi (no crash on missing fields)', () => {
  const r = routeExecutor({ prompt_chars: 0 });
  expect(r.executor_model).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(r.routing_source).toBe('fallback_no_difficulty');
  expect(r.ok).toBe(true);
});

test('Phase 8 #4: explicit unallowlisted executor_model still drops back to Kimi (allowlist preserved)', () => {
  const r = routeExecutor({
    story: {
      executor_model: 'openrouter/totally/made-up-model-v99',
      difficulty: 'hard'  // even with a valid tier, explicit-but-unallowed STILL falls back
    },
    prompt_chars: 50
  });
  expect(r.executor_model).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(r.routing_source).toBe('fallback_unallowed_explicit');
  expect(r.reason).toBe('executor_model_not_allowed');
  expect(r.ok).toBe(false);
});
