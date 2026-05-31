const { test, expect } = require('@playwright/test');

const {
  ESCALATION_LADDER,
  tierForComplexity,
  effectiveComplexity,
  selectModel
} = require('../../src/ralph/nemoclaw-brain');

const KIMI = 'openrouter/moonshotai/kimi-k2.6';
const HAIKU = 'openrouter/anthropic/claude-haiku-4.5';
const SONNET = 'openrouter/anthropic/claude-sonnet-4.6';
const GPT5 = 'openrouter/openai/gpt-5';
const OPUS = 'openrouter/anthropic/claude-opus-4.7';

// Build an outcomes record matching the shape routing-stats expects.
function outcome({ story_id, context_bucket, model, succeeded, cost_usd = 0.05 }) {
  return {
    task: { story_id, context_bucket },
    executions: [{ role: 'executor', status: 'succeeded', model, succeeded, cost_usd, fix_loop_attempts: 0 }]
  };
}

test('tierForComplexity maps complexity bands to the cost ladder', () => {
  expect(tierForComplexity(0.05)).toBe(0);
  expect(tierForComplexity(0.29)).toBe(0);
  expect(tierForComplexity(0.30)).toBe(1);
  expect(tierForComplexity(0.54)).toBe(1);
  expect(tierForComplexity(0.55)).toBe(2);
  expect(tierForComplexity(0.74)).toBe(2);
  expect(tierForComplexity(0.75)).toBe(3);
  expect(tierForComplexity(0.99)).toBe(3);
});

test('effectiveComplexity lifts hard code work the classifier under-rates', () => {
  // A hard code task: low overall (creativity-weighted) but high reasoning+domain.
  const hardCode = { task_type: 'Code Generation', prompt_complexity_score: 0.22, reasoning: 0.85, domain_knowledge: 0.9, constraint_ct: 0.6 };
  expect(effectiveComplexity(hardCode)).toBeGreaterThan(0.55); // climbs into sonnet/gpt tier
  // Trivial code stays low (no reasoning/domain).
  const easyCode = { task_type: 'Code Generation', prompt_complexity_score: 0.18, reasoning: 0.01, domain_knowledge: 0.05, constraint_ct: 0.0 };
  expect(effectiveComplexity(easyCode)).toBeLessThan(0.30);
  // Non-code tasks use the overall score unchanged.
  const prose = { task_type: 'Text Generation', prompt_complexity_score: 0.4, reasoning: 0.9 };
  expect(effectiveComplexity(prose)).toBe(0.4);
});

test('hard code task routes above tier 0 despite low overall complexity', () => {
  const r = selectModel({
    story: { story_id: 'S' },
    classifierSignal: { task_type: 'Code Generation', prompt_complexity_score: 0.22, reasoning: 0.85, domain_knowledge: 0.9, constraint_ct: 0.6 }
  });
  // Without the code-aware lift this would be Kimi (tier 0); now it escalates.
  expect(r.tier).toBeGreaterThanOrEqual(2);
});

test('explicit story.executor_model always wins (allowlisted)', () => {
  const r = selectModel({ story: { executor_model: SONNET, difficulty: 'trivial' } });
  expect(r.model).toBe(SONNET);
  expect(r.source).toBe('story_explicit');
  expect(r.fallback_applied).toBe(false);
});

test('cold start with no signal routes to the cheap workhorse', () => {
  const r = selectModel({ story: { story_id: 'S' } });
  expect(r.model).toBe(KIMI);
  expect(r.source).toBe('cold_start');
  expect(r.tier).toBe(0);
});

test('classifier complexity drives the tier (NVIDIA complexity_router)', () => {
  const hard = selectModel({
    story: { story_id: 'S' },
    classifierSignal: { task_type: 'Code Generation', prompt_complexity_score: 0.8 }
  });
  expect(hard.model).toBe(GPT5);
  expect(hard.source).toBe('classifier_tier');
  expect(hard.task_type).toBe('Code Generation');

  const medium = selectModel({
    story: { story_id: 'S' },
    classifierSignal: { task_type: 'Code Generation', prompt_complexity_score: 0.4 }
  });
  expect(medium.model).toBe(HAIKU);
});

test('classifier signal overrides a mispredicted static difficulty', () => {
  // story says "easy" but the classifier sees high complexity → trust the
  // classifier (this is the outcomes.jsonl predicted=easy / actual=hard fix).
  const r = selectModel({
    story: { story_id: 'S', difficulty: 'easy' },
    classifierSignal: { task_type: 'Code Generation', prompt_complexity_score: 0.7 }
  });
  expect(r.model).toBe(SONNET);
  expect(r.source).toBe('classifier_tier');
});

test('difficulty tier is used only when no classifier signal exists', () => {
  const r = selectModel({ story: { story_id: 'S', difficulty: 'hard' } });
  expect(r.model).toBe(SONNET);
  expect(r.source).toBe('difficulty_tier');
});

test('confident learned recommendation wins over the cold-start tier', () => {
  const bucket = 'easy|create|js|2-3f';
  const outcomes = [
    outcome({ story_id: 'a', context_bucket: bucket, model: HAIKU, succeeded: true }),
    outcome({ story_id: 'b', context_bucket: bucket, model: HAIKU, succeeded: true }),
    outcome({ story_id: 'c', context_bucket: bucket, model: KIMI, succeeded: false })
  ];
  const r = selectModel({
    story: { story_id: 'S', context_bucket: bucket, difficulty: 'easy' },
    outcomes,
    minSamples: 2
  });
  expect(r.source).toBe('learned');
  expect(r.model).toBe(HAIKU);
});

test('a confident learnedRec (e.g. from D1) is honored directly', () => {
  const r = selectModel({
    story: { story_id: 'S', context_bucket: 'easy|create|js|2-3f', difficulty: 'easy' },
    learnedRec: { model: SONNET, success_rate: 0.9, samples: 5, low_confidence: false }
  });
  expect(r.source).toBe('learned');
  expect(r.model).toBe(SONNET);
});

test('a low-confidence learnedRec is ignored (falls back to tier)', () => {
  const r = selectModel({
    story: { story_id: 'S', context_bucket: 'b', difficulty: 'easy' },
    learnedRec: { model: SONNET, success_rate: 0.9, samples: 1, low_confidence: true }
  });
  expect(r.source).not.toBe('learned');
  expect(r.model).toBe(KIMI);
});

test('low-sample history does NOT override the cold-start tier', () => {
  const bucket = 'easy|create|js|2-3f';
  const outcomes = [outcome({ story_id: 'a', context_bucket: bucket, model: SONNET, succeeded: true })];
  const r = selectModel({
    story: { story_id: 'S', context_bucket: bucket, difficulty: 'easy' },
    outcomes,
    minSamples: 2
  });
  expect(r.source).not.toBe('learned');
  expect(r.model).toBe(KIMI); // easy → tier 0
});

test('non-transient failure escalates one rung per attempt', () => {
  const story = { story_id: 'S', difficulty: 'easy' }; // base tier 0
  const a1 = selectModel({ story, attempt: 1, lastFailureClass: 'opencode_kimi_runtime_timeout' });
  expect(a1.source).toBe('escalated');
  expect(a1.model).toBe(HAIKU); // tier 1
  const a2 = selectModel({ story, attempt: 2, lastFailureClass: 'gate_failure' });
  expect(a2.model).toBe(SONNET); // tier 2
});

test('transient failure retries the same tier (no rung bump)', () => {
  const story = { story_id: 'S', difficulty: 'medium' }; // base tier 1
  const r = selectModel({ story, attempt: 1, lastFailureClass: 'provider_rate_limited' });
  expect(r.source).toBe('escalated_retry_same_tier');
  expect(r.model).toBe(HAIKU); // stays tier 1
});

test('architectural escalates to Opus (last resort) before exhausting', () => {
  const story = { story_id: 'S', difficulty: 'architectural' }; // base tier 3
  const r = selectModel({ story, attempt: 1, lastFailureClass: 'gate_failure' });
  expect(r.model).toBe(OPUS); // tier 4 — must-implement last resort
  expect(r.escalate_to_human).toBe(false);
});

test('exhausting the full ladder (past Opus) flags human escalation', () => {
  const story = { story_id: 'S', difficulty: 'architectural' }; // base tier 3
  const r = selectModel({ story, attempt: 2, lastFailureClass: 'gate_failure' });
  expect(r.model).toBe(OPUS); // capped at top (tier 4)
  expect(r.escalate_to_human).toBe(true); // wanted tier 5 > top
});

test('per-story cost cap flips escalate_to_human', () => {
  const r = selectModel({
    story: { story_id: 'S', difficulty: 'easy' },
    spentUsd: 0.6,
    env: { RALPH_STORY_COST_CAP_USD: '0.5' }
  });
  expect(r.escalate_to_human).toBe(true);
  expect(r.cost_cap_usd).toBe(0.5);
});

test('output always carries an allowlisted model and the ladder', () => {
  const r = selectModel({ story: { story_id: 'S' } });
  expect(ESCALATION_LADDER).toContain(r.model);
  expect(Array.isArray(r.ladder)).toBe(true);
  expect(r.ladder.length).toBeGreaterThan(0);
});
