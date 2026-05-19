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
