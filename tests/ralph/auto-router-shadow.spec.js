const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AUTO_MODEL,
  blendedRate,
  probeAutoRouter,
  compareRouting,
  recordShadow,
  summarizeShadow
} = require('../../src/ralph/auto-router-shadow');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'auto-router-shadow-'));
}

// Fake fetch returning a canned OpenRouter response.
function fakeFetch(model, cost = 0.000001) {
  return async () => ({
    json: async () => ({ model, id: 'gen-test', usage: { cost } })
  });
}

test('blendedRate ranks known models by (input+output)/2', () => {
  const kimi = blendedRate('openrouter/moonshotai/kimi-k2.6');
  const sonnet = blendedRate('openrouter/anthropic/claude-sonnet-4.6');
  expect(sonnet).toBeGreaterThan(kimi);
});

test('probeAutoRouter requires api key and prompt', async () => {
  expect((await probeAutoRouter({ prompt: 'x' })).ok).toBe(false);
  expect((await probeAutoRouter({ apiKey: 'k' })).ok).toBe(false);
});

test('probeAutoRouter returns chosen model + cost from response', async () => {
  const r = await probeAutoRouter({
    prompt: 'do a thing',
    apiKey: 'k',
    fetchImpl: fakeFetch('google/gemini-2.5-flash-lite', 9e-7)
  });
  expect(r.ok).toBe(true);
  expect(r.chosen_model).toBe('google/gemini-2.5-flash-lite');
  expect(r.probe_cost_usd).toBe(9e-7);
});

test('probeAutoRouter handles missing model in response', async () => {
  const r = await probeAutoRouter({
    prompt: 'x', apiKey: 'k',
    fetchImpl: async () => ({ json: async () => ({ choices: [] }) })
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('no_model_in_response');
});

test('probeAutoRouter catches network errors', async () => {
  const r = await probeAutoRouter({
    prompt: 'x', apiKey: 'k',
    fetchImpl: async () => { throw new Error('boom'); }
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('probe_failed');
});

test('compareRouting detects agreement', () => {
  const c = compareRouting({
    ladder_model: 'openrouter/anthropic/claude-haiku-4.5',
    auto_model: 'openrouter/anthropic/claude-haiku-4.5'
  });
  expect(c.agree).toBe(true);
  expect(c.cost_relation).toBe('same');
});

test('compareRouting flags auto cheaper / pricier', () => {
  const cheaper = compareRouting({
    ladder_model: 'openrouter/anthropic/claude-sonnet-4.6',
    auto_model: 'openrouter/moonshotai/kimi-k2.6'
  });
  expect(cheaper.agree).toBe(false);
  expect(cheaper.cost_relation).toBe('auto_cheaper');

  const pricier = compareRouting({
    ladder_model: 'openrouter/moonshotai/kimi-k2.6',
    auto_model: 'openrouter/openai/gpt-5'
  });
  expect(pricier.cost_relation).toBe('auto_pricier');
});

test('compareRouting handles missing models', () => {
  expect(compareRouting({ ladder_model: 'x' }).comparable).toBe(false);
  expect(compareRouting({}).comparable).toBe(false);
});

test('compareRouting flags unpriced auto picks instead of faking equal_rate', () => {
  // auto-router picks a bleeding-edge model not in MODEL_PRICING
  const c = compareRouting({
    ladder_model: 'openrouter/moonshotai/kimi-k2.6',
    auto_model: 'google/gemini-3-flash-preview-20251217'
  });
  expect(c.agree).toBe(false);
  expect(c.cost_relation).toBe('unpriced');
  expect(c.auto_priced).toBe(false);
  expect(c.note).toMatch(/not in MODEL_PRICING/);
});

test('recordShadow appends a jsonl entry', () => {
  const rootDir = tmpRoot();
  const comparison = compareRouting({
    ladder_model: 'openrouter/anthropic/claude-haiku-4.5',
    auto_model: 'openrouter/moonshotai/kimi-k2.6'
  });
  const r = recordShadow({
    rootDir,
    story: { story_id: 'S1', difficulty: 'medium' },
    ladder_model: 'openrouter/anthropic/claude-haiku-4.5',
    auto_result: { ok: true, chosen_model: 'openrouter/moonshotai/kimi-k2.6', probe_cost_usd: 1e-6 },
    comparison
  });
  expect(r.ok).toBe(true);
  const parsed = JSON.parse(fs.readFileSync(r.path, 'utf8').trim());
  expect(parsed.story_id).toBe('S1');
  expect(parsed.auto_model).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(parsed.comparison.cost_relation).toBe('auto_cheaper');
});

test('summarizeShadow aggregates agreement & cost relation by difficulty', () => {
  const entries = [
    { difficulty: 'medium', comparison: { comparable: true, agree: true } },
    { difficulty: 'medium', comparison: { comparable: true, agree: false, cost_relation: 'auto_cheaper' } },
    { difficulty: 'hard', comparison: { comparable: true, agree: false, cost_relation: 'auto_pricier' } },
    { difficulty: 'hard', comparison: { comparable: false } } // skipped
  ];
  const s = summarizeShadow(entries);
  expect(s.total).toBe(3);
  expect(s.agree).toBe(1);
  expect(s.auto_cheaper).toBe(1);
  expect(s.auto_pricier).toBe(1);
  expect(s.by_difficulty.medium.total).toBe(2);
  expect(s.by_difficulty.medium.auto_cheaper).toBe(1);
});

test('AUTO_MODEL is the openrouter auto slug', () => {
  expect(AUTO_MODEL).toBe('openrouter/auto');
});
