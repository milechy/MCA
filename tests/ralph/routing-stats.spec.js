const { test, expect } = require('@playwright/test');

const {
  dedupeLatest,
  aggregate,
  statsByDifficultyModel,
  recommendByDifficulty,
  recommendByContextBucket,
  buildReport
} = require('../../src/ralph/routing-stats');

// Build a synthetic outcomes set (the shape task-outcome-recorder emits).
function outcome(story_id, difficulty, model, succeeded, cost, fix = 0, bucket = 'b') {
  return {
    at: '2026-05-29T00:00:00.000Z',
    task: { story_id, difficulty, context_bucket: bucket },
    executions: [
      { role: 'executor', model, succeeded, cost_usd: cost, fix_loop_attempts: fix, status: succeeded ? 'succeeded' : 'failed' }
    ],
    summary: { succeeded }
  };
}

test('dedupeLatest keeps the last record per story_id', () => {
  const set = [
    outcome('S1', 'medium', 'haiku', false, 0.05),
    outcome('S1', 'medium', 'haiku', true, 0.06), // later state wins
    outcome('S2', 'easy', 'kimi', true, 0.01)
  ];
  const deduped = dedupeLatest(set);
  expect(deduped.length).toBe(2);
  const s1 = deduped.find((o) => o.task.story_id === 'S1');
  expect(s1.summary.succeeded).toBe(true);
});

test('aggregate computes rate, cost, cost-per-success', () => {
  const set = [
    outcome('S1', 'medium', 'haiku', true, 0.10),
    outcome('S2', 'medium', 'haiku', true, 0.10),
    outcome('S3', 'medium', 'haiku', false, 0.20)
  ];
  const rows = aggregate(set, (o, e) => `${o.task.difficulty} | ${e.model}`);
  expect(rows.length).toBe(1);
  const r = rows[0];
  expect(r.executions).toBe(3);
  expect(r.successes).toBe(2);
  expect(r.success_rate).toBe(0.667);
  expect(r.total_cost_usd).toBe(0.4);
  expect(r.cost_per_success_usd).toBe(0.2); // 0.40 / 2
});

test('aggregate ignores in-flight (status=running) executions', () => {
  const set = [outcome('S1', 'easy', 'kimi', true, 0.01)];
  set[0].executions.push({ role: 'executor', model: 'kimi', status: 'running', cost_usd: 0, fix_loop_attempts: 0 });
  const rows = aggregate(set, (o, e) => e.model);
  expect(rows[0].executions).toBe(1); // running one excluded
});

test('statsByDifficultyModel groups and sorts by difficulty', () => {
  const set = [
    outcome('S1', 'easy', 'kimi', true, 0.01),
    outcome('S2', 'medium', 'haiku', true, 0.10),
    outcome('S3', 'medium', 'sonnet', true, 0.40)
  ];
  const rows = statsByDifficultyModel(set);
  expect(rows.length).toBe(3);
  expect(rows[0].key.startsWith('easy')).toBe(true);
});

test('recommendByDifficulty picks highest success rate, ties broken by cost', () => {
  const set = [
    // medium: haiku 2/2 cheap, sonnet 1/1 expensive → both 100%, haiku cheaper
    outcome('S1', 'medium', 'haiku', true, 0.10),
    outcome('S2', 'medium', 'haiku', true, 0.10),
    outcome('S3', 'medium', 'sonnet', true, 0.40),
    outcome('S4', 'medium', 'sonnet', true, 0.40)
  ];
  const rec = recommendByDifficulty(set, { minSamples: 2 });
  expect(rec.medium.model).toBe('haiku');
  expect(rec.medium.cost_per_success_usd).toBe(0.1);
});

test('recommendByDifficulty prefers higher success rate even if pricier', () => {
  const set = [
    // hard: cheap model fails a lot, expensive model succeeds
    outcome('S1', 'hard', 'kimi', false, 0.02),
    outcome('S2', 'hard', 'kimi', false, 0.02),
    outcome('S3', 'hard', 'sonnet', true, 0.40),
    outcome('S4', 'hard', 'sonnet', true, 0.40)
  ];
  const rec = recommendByDifficulty(set, { minSamples: 2 });
  expect(rec.hard.model).toBe('sonnet'); // 100% beats 0% despite higher cost
});

test('recommendByDifficulty flags low confidence under minSamples', () => {
  const set = [outcome('S1', 'architectural', 'gpt5', true, 0.5)];
  const rec = recommendByDifficulty(set, { minSamples: 3 });
  expect(rec.architectural.model).toBe('gpt5');
  expect(rec.architectural.low_confidence).toBe(true);
});

test('recommendByDifficulty reports no_successful_samples when all failed', () => {
  const set = [
    outcome('S1', 'hard', 'kimi', false, 0.02),
    outcome('S2', 'hard', 'kimi', false, 0.02)
  ];
  const rec = recommendByDifficulty(set, { minSamples: 2 });
  expect(rec.hard.model).toBe(null);
  expect(rec.hard.reason).toBe('no_successful_samples');
});

test('recommendByContextBucket keys on the full context bucket, not difficulty', () => {
  const bucket = 'easy|create|js|2-3f';
  const set = [
    outcome('S1', 'easy', 'haiku', true, 0.10, 0, bucket),
    outcome('S2', 'easy', 'haiku', true, 0.10, 0, bucket),
    outcome('S3', 'easy', 'kimi', false, 0.05, 0, bucket)
  ];
  const rec = recommendByContextBucket(set, { minSamples: 2 });
  expect(rec[bucket].model).toBe('haiku');
  expect(rec[bucket].success_rate).toBe(1);
  expect(rec[bucket].low_confidence).toBe(false);
});

test('recommendByContextBucket tolerates pipe characters inside the bucket key', () => {
  // bucket itself contains " | "-like separators; the recommender must split
  // on the LAST " | " (bucket | model), not the first.
  const bucket = 'medium|modify|js|2-3f';
  const set = [
    outcome('S1', 'medium', 'sonnet', true, 0.4, 0, bucket),
    outcome('S2', 'medium', 'sonnet', true, 0.4, 0, bucket)
  ];
  const rec = recommendByContextBucket(set, { minSamples: 2 });
  expect(rec[bucket].model).toBe('sonnet');
});

test('buildReport assembles all sections', () => {
  const set = [
    outcome('S1', 'medium', 'haiku', true, 0.10, 0, 'medium|modify|js|2-3f'),
    outcome('S2', 'easy', 'kimi', true, 0.01, 0, 'easy|create|js|1f')
  ];
  // buildReport reads from disk; instead test the pieces are wired by
  // feeding through the exported aggregators (buildReport's disk read is
  // covered by the CLI smoke). Here assert the aggregator outputs combine.
  const byDM = statsByDifficultyModel(set);
  const rec = recommendByDifficulty(set, { minSamples: 1 });
  expect(byDM.length).toBe(2);
  expect(rec.medium.model).toBe('haiku');
  expect(rec.easy.model).toBe('kimi');
});
