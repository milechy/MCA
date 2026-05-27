const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_DAILY_BUDGET_USD,
  estimateTokens,
  estimateCostUsd,
  recordKimiCall,
  readDailySpend,
  dailyBudgetCap,
  isOverBudget
} = require('../../src/ralph/kimi-cost-tracker');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-cost-tracker-'));
}

test('estimateTokens divides character count by 4', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('a'.repeat(100))).toBe(25);
  expect(estimateTokens(null)).toBe(0);
  expect(estimateTokens(undefined)).toBe(0);
});

test('estimateCostUsd applies Kimi K2.6 OpenRouter rates', () => {
  const cost = estimateCostUsd({ input_tokens: 1000, output_tokens: 1000 });
  expect(cost).toBe(0.001);
});

test('recordKimiCall appends one JSONL line and computes tokens from prompt_text / output_text', () => {
  const rootDir = tmpRoot();
  const result1 = recordKimiCall({
    rootDir,
    story_id: 'STORY-1',
    prompt_text: 'a'.repeat(40),
    output_text: 'b'.repeat(80),
    model: 'openrouter/moonshotai/kimi-k2.6'
  });
  expect(result1.ok).toBe(true);
  expect(result1.entry).toBeTruthy();
  expect(result1.entry.story_id).toBe('STORY-1');
  expect(result1.entry.input_tokens).toBe(10);
  expect(result1.entry.output_tokens).toBe(20);

  const result2 = recordKimiCall({
    rootDir,
    story_id: 'STORY-2',
    prompt_text: 'c'.repeat(20),
    output_text: 'd'.repeat(40),
    model: 'openrouter/moonshotai/kimi-k2.6'
  });
  expect(result2.ok).toBe(true);
  expect(result2.entry.story_id).toBe('STORY-2');

  const ledger = fs.readFileSync(result1.ledger_path, 'utf8').trim().split('\n');
  expect(ledger.length).toBe(2);
  const parsed = ledger.map((line) => JSON.parse(line));
  expect(parsed[0].story_id).toBe('STORY-1');
  expect(parsed[1].story_id).toBe('STORY-2');
});

test('readDailySpend filters by date and sums', () => {
  const rootDir = tmpRoot();
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });

  const line1 = JSON.stringify({
    at: '2026-05-19T10:00:00.000Z',
    story_id: 'STORY-A',
    model: 'kimi',
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.0006
  });
  const line2 = JSON.stringify({
    at: '2026-05-19T14:00:00.000Z',
    story_id: 'STORY-B',
    model: 'kimi',
    input_tokens: 2000,
    output_tokens: 1000,
    cost_usd: 0.0012
  });
  const line3 = JSON.stringify({
    at: '2026-05-20T08:00:00.000Z',
    story_id: 'STORY-C',
    model: 'kimi',
    input_tokens: 1000,
    output_tokens: 1000,
    cost_usd: 0.001
  });

  fs.writeFileSync(ledgerPath, [line1, line2, line3].join('\n') + '\n', 'utf8');

  const spend = readDailySpend({ rootDir, date: new Date('2026-05-19T00:00:00Z') });
  expect(spend.date_iso).toBe('2026-05-19');
  expect(spend.entries.length).toBe(2);
  expect(spend.input_tokens).toBe(3000);
  expect(spend.output_tokens).toBe(1500);
  expect(spend.cost_usd).toBe(0.0018);
  expect(spend.story_count).toBe(2);
});

test('readDailySpend returns zeros when ledger missing', () => {
  const rootDir = tmpRoot();
  const spend = readDailySpend({ rootDir });
  expect(spend.cost_usd).toBe(0);
  expect(spend.story_count).toBe(0);
  expect(spend.input_tokens).toBe(0);
  expect(spend.output_tokens).toBe(0);
  expect(spend.entries.length).toBe(0);
});

test('dailyBudgetCap falls back to default when env is invalid', () => {
  expect(dailyBudgetCap({ env: {} })).toBe(DEFAULT_DAILY_BUDGET_USD);
  expect(dailyBudgetCap({ env: { RALPH_KIMI_DAILY_BUDGET_USD: '2.5' } })).toBe(2.5);
  expect(dailyBudgetCap({ env: { RALPH_KIMI_DAILY_BUDGET_USD: 'abc' } })).toBe(DEFAULT_DAILY_BUDGET_USD);
  expect(dailyBudgetCap({ env: { RALPH_KIMI_DAILY_BUDGET_USD: '0' } })).toBe(DEFAULT_DAILY_BUDGET_USD);
  expect(dailyBudgetCap({ env: { RALPH_KIMI_DAILY_BUDGET_USD: '-1' } })).toBe(DEFAULT_DAILY_BUDGET_USD);
});

test('isOverBudget true when daily_spend exceeds cap', () => {
  const rootDir = tmpRoot();
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });

  const entry = {
    at: new Date().toISOString(),
    story_id: 'STORY-EXPENSIVE',
    model: 'kimi',
    input_tokens: 100_000_000,
    output_tokens: 100_000_000,
    cost_usd: 100.0
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');

  const check = isOverBudget({ rootDir, env: { RALPH_KIMI_DAILY_BUDGET_USD: '0.01' }, now: new Date() });
  expect(check.over).toBe(true);
  expect(check.daily_spend).toBe(100.0);
  expect(check.daily_cap).toBe(0.01);
});

// ============================================================
// Phase 3 #1: per-model pricing tests
// ============================================================

const { MODEL_PRICING, pricingForModel } = require('../../src/ralph/kimi-cost-tracker');

test('Phase 3 #1: MODEL_PRICING contains entries for Kimi, Claude, GPT-5, Gemini', () => {
  expect(MODEL_PRICING['openrouter/moonshotai/kimi-k2.6']).toBeDefined();
  expect(MODEL_PRICING['openrouter/anthropic/claude-sonnet-4.6']).toBeDefined();
  expect(MODEL_PRICING['openrouter/openai/gpt-5']).toBeDefined();
  expect(MODEL_PRICING['openrouter/google/gemini-3.0-pro']).toBeDefined();
});

test('Phase 3 #1: pricingForModel returns Kimi rates for unknown models (fallback)', () => {
  const p = pricingForModel('some/unknown/model-xyz');
  expect(p.label).toBe('fallback_kimi_rates');
  expect(p.input).toBe(0.0000002);
  expect(p.output).toBe(0.0000008);
});

test('Phase 3 #1: estimateCostUsd uses Claude Sonnet pricing for that model', () => {
  // Sonnet 4.6: $3/$15 per 1M = 0.000003 / 0.000015 per token
  const cost = estimateCostUsd({
    input_tokens: 1000,
    output_tokens: 1000,
    model: 'openrouter/anthropic/claude-sonnet-4.6'
  });
  // 1000 * 0.000003 + 1000 * 0.000015 = 0.003 + 0.015 = 0.018
  expect(cost).toBe(0.018);
});

test('Phase 3 #1: estimateCostUsd uses GPT-5 pricing for that model', () => {
  // GPT-5: $5/$15 per 1M = 0.000005 / 0.000015 per token
  const cost = estimateCostUsd({
    input_tokens: 1000,
    output_tokens: 1000,
    model: 'openrouter/openai/gpt-5'
  });
  // 1000 * 0.000005 + 1000 * 0.000015 = 0.005 + 0.015 = 0.020
  expect(cost).toBe(0.020);
});

test('Phase 3 #1: estimateCostUsd without model arg uses fallback Kimi rates', () => {
  // Backwards-compat: callers that don't pass model still work.
  const cost = estimateCostUsd({ input_tokens: 1000, output_tokens: 1000 });
  // 1000 * 0.0000002 + 1000 * 0.0000008 = 0.001
  expect(cost).toBe(0.001);
});

test('Phase 3 #1: recordKimiCall records pricing_source = model label when known', () => {
  const rootDir = tmpRoot();
  const r = recordKimiCall({
    rootDir,
    story_id: 'STORY-CLAUDE',
    prompt_text: 'x'.repeat(4000),
    output_text: 'y'.repeat(4000),
    model: 'openrouter/anthropic/claude-sonnet-4.6'
  });
  expect(r.ok).toBe(true);
  expect(r.entry.pricing_source).toBe('claude-sonnet-4.6');
  expect(r.entry.cost_usd).toBeGreaterThan(0);
});

test('Phase 3 #1: recordKimiCall records pricing_source = fallback_kimi_rates for unknown model', () => {
  const rootDir = tmpRoot();
  const r = recordKimiCall({
    rootDir,
    story_id: 'STORY-UNKNOWN',
    prompt_text: 'x'.repeat(100),
    output_text: 'y'.repeat(100),
    model: 'some/exotic/model-not-in-table'
  });
  expect(r.ok).toBe(true);
  expect(r.entry.pricing_source).toBe('fallback_kimi_rates');
});

// ============================================================
// Phase 8 #2: DeepSeek family pricing entries (planner default switch)
// ============================================================

test('Phase 8 #2: MODEL_PRICING contains DeepSeek V3 (chat) and R1 entries with sane rates', () => {
  const v3 = MODEL_PRICING['openrouter/deepseek/deepseek-chat'];
  const r1 = MODEL_PRICING['openrouter/deepseek/deepseek-r1'];
  expect(v3).toBeDefined();
  expect(r1).toBeDefined();
  // Sanity: input ≤ output, both positive, and DeepSeek V3 cheaper than Kimi
  // K2.6 input rate ($0.20/1M) — that's the threshold below which we said the
  // planner switch is worth it. (Kimi rate: 0.0000002 = $0.20/1M.)
  expect(v3.input).toBeLessThanOrEqual(v3.output);
  expect(v3.input).toBeGreaterThan(0);
  // DeepSeek V3 input rate should be well below Sonnet 4.6's ($3/1M = 0.000003).
  expect(v3.input).toBeLessThan(0.000001);
  // DeepSeek R1 is a reasoning model — slightly pricier than V3 but still cheap.
  expect(r1.input).toBeGreaterThan(0);
  expect(r1.input).toBeLessThan(0.000005);
});

test('Phase 8 #2: pricingForModel returns DeepSeek rates (NOT fallback) for DeepSeek slugs', () => {
  const v3 = pricingForModel('openrouter/deepseek/deepseek-chat');
  expect(v3.label).toBe('deepseek-v3-chat');
  expect(v3.label).not.toBe('fallback_kimi_rates');
  const r1 = pricingForModel('openrouter/deepseek/deepseek-r1');
  expect(r1.label).toBe('deepseek-r1');
});
