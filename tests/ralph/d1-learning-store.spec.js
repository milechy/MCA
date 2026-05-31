const { test, expect } = require('@playwright/test');

const { isConfigured, recommendForBucket, recordOutcome } = require('../../src/ralph/d1-learning-store');

const ENV = { CLOUDFLARE_ACCOUNT_ID: 'acc', RALPH_D1_DATABASE_ID: 'db', CLOUDFLARE_API_TOKEN: 'tok' };

// Build a fake fetch that returns the D1 REST shape and captures calls.
function fakeFetch(rows, { capture } = {}) {
  return async (url, init) => {
    if (capture) capture.push(JSON.parse(init.body));
    return { json: async () => ({ success: true, result: [{ results: rows, success: true }] }) };
  };
}

test('isConfigured requires account, db, and token', () => {
  expect(isConfigured(ENV)).toBe(true);
  expect(isConfigured({ CLOUDFLARE_ACCOUNT_ID: 'a' })).toBe(false);
  expect(isConfigured({})).toBe(false);
});

test('recommendForBucket picks highest success_rate, tie-broken by cost', async () => {
  const rows = [
    { model: 'haiku', executions: 4, success_rate: 1, cost_per_success_usd: 0.1 },
    { model: 'kimi', executions: 3, success_rate: 0.5, cost_per_success_usd: 0.02 }
  ];
  const rec = await recommendForBucket({ contextBucket: 'easy|create|js|2-3f', env: ENV, fetchImpl: fakeFetch(rows) });
  expect(rec.model).toBe('haiku');
  expect(rec.success_rate).toBe(1);
  expect(rec.low_confidence).toBe(false);
});

test('recommendForBucket returns null with no rows', async () => {
  const rec = await recommendForBucket({ contextBucket: 'x', env: ENV, fetchImpl: fakeFetch([]) });
  expect(rec).toBe(null);
});

test('recommendForBucket returns null when D1 is not configured', async () => {
  const rec = await recommendForBucket({ contextBucket: 'x', env: {}, fetchImpl: fakeFetch([{ model: 'a', executions: 9, success_rate: 1, cost_per_success_usd: 0.1 }]) });
  expect(rec).toBe(null);
});

test('recordOutcome issues task upsert + execution insert + policy update', async () => {
  const capture = [];
  const r = await recordOutcome({
    story_id: 'issue-1', context_bucket: 'easy|create|js|2-3f', difficulty: 'easy',
    model: 'kimi', attempt_number: 0, succeeded: true, cost_usd: 0.04, failure_class: null,
    env: ENV, fetchImpl: fakeFetch([], { capture }), idImpl: () => 'fixed-id'
  });
  expect(r.ok).toBe(true);
  expect(r.status).toBe('succeeded');
  // 3 statements: tasks upsert, model_executions insert, routing_policy upsert.
  expect(capture.length).toBe(3);
  expect(capture[0].sql).toMatch(/INSERT INTO tasks/);
  expect(capture[1].sql).toMatch(/INSERT INTO model_executions/);
  expect(capture[1].params).toContain('fixed-id');
  expect(capture[2].sql).toMatch(/routing_policy/);
});

test('recordOutcome skips routing_policy when outcome is in-flight (succeeded null)', async () => {
  const capture = [];
  await recordOutcome({
    story_id: 'issue-2', context_bucket: 'b', model: 'kimi', succeeded: null,
    env: ENV, fetchImpl: fakeFetch([], { capture })
  });
  expect(capture.length).toBe(2); // no policy update
});

test('recordOutcome no-ops without story_id or model', async () => {
  const r = await recordOutcome({ env: ENV, fetchImpl: fakeFetch([]) });
  expect(r.ok).toBe(false);
});
