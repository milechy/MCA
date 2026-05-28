const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSpendWindow } = require('../../src/ralph/kimi-cost-tracker');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spend-window-'));
}

test('readSpendWindow filters by both since and until', () => {
  const rootDir = tmpRoot();
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });

  const line1 = JSON.stringify({
    at: '2026-05-19T08:00:00.000Z',
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
  const line4 = JSON.stringify({
    at: '2026-05-21T10:00:00.000Z',
    story_id: 'STORY-D',
    model: 'kimi',
    input_tokens: 500,
    output_tokens: 500,
    cost_usd: 0.0005
  });

  fs.writeFileSync(ledgerPath, [line1, line2, line3, line4].join('\n') + '\n', 'utf8');

  const result = readSpendWindow({
    rootDir,
    since: '2026-05-19T12:00:00.000Z',
    until: '2026-05-20T12:00:00.000Z'
  });

  expect(result.entries.length).toBe(2);
  expect(result.entries[0].story_id).toBe('STORY-B');
  expect(result.entries[1].story_id).toBe('STORY-C');
  expect(result.input_tokens).toBe(3000);
  expect(result.output_tokens).toBe(2000);
  expect(result.cost_usd).toBe(0.0022);
  expect(result.story_count).toBe(2);
});

test('readSpendWindow filters by since only (no upper bound)', () => {
  const rootDir = tmpRoot();
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });

  const line1 = JSON.stringify({
    at: '2026-05-19T08:00:00.000Z',
    story_id: 'STORY-A',
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.0006
  });
  const line2 = JSON.stringify({
    at: '2026-05-20T14:00:00.000Z',
    story_id: 'STORY-B',
    input_tokens: 2000,
    output_tokens: 1000,
    cost_usd: 0.0012
  });
  const line3 = JSON.stringify({
    at: '2026-05-21T08:00:00.000Z',
    story_id: 'STORY-C',
    input_tokens: 1000,
    output_tokens: 1000,
    cost_usd: 0.001
  });

  fs.writeFileSync(ledgerPath, [line1, line2, line3].join('\n') + '\n', 'utf8');

  const result = readSpendWindow({
    rootDir,
    since: '2026-05-20T00:00:00.000Z'
  });

  expect(result.entries.length).toBe(2);
  expect(result.entries[0].story_id).toBe('STORY-B');
  expect(result.entries[1].story_id).toBe('STORY-C');
  expect(result.input_tokens).toBe(3000);
  expect(result.output_tokens).toBe(2000);
  expect(result.cost_usd).toBe(0.0022);
  expect(result.story_count).toBe(2);
});

test('readSpendWindow filters by until only (no lower bound)', () => {
  const rootDir = tmpRoot();
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });

  const line1 = JSON.stringify({
    at: '2026-05-19T08:00:00.000Z',
    story_id: 'STORY-A',
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.0006
  });
  const line2 = JSON.stringify({
    at: '2026-05-20T14:00:00.000Z',
    story_id: 'STORY-B',
    input_tokens: 2000,
    output_tokens: 1000,
    cost_usd: 0.0012
  });
  const line3 = JSON.stringify({
    at: '2026-05-21T08:00:00.000Z',
    story_id: 'STORY-C',
    input_tokens: 1000,
    output_tokens: 1000,
    cost_usd: 0.001
  });

  fs.writeFileSync(ledgerPath, [line1, line2, line3].join('\n') + '\n', 'utf8');

  const result = readSpendWindow({
    rootDir,
    until: '2026-05-20T23:59:59.999Z'
  });

  expect(result.entries.length).toBe(2);
  expect(result.entries[0].story_id).toBe('STORY-A');
  expect(result.entries[1].story_id).toBe('STORY-B');
  expect(result.input_tokens).toBe(3000);
  expect(result.output_tokens).toBe(1500);
  expect(result.cost_usd).toBe(0.0018);
  expect(result.story_count).toBe(2);
});

test('readSpendWindow returns zeros when ledger missing', () => {
  const rootDir = tmpRoot();
  const result = readSpendWindow({
    rootDir,
    since: '2026-05-19T00:00:00.000Z',
    until: '2026-05-20T00:00:00.000Z'
  });

  expect(result.entries.length).toBe(0);
  expect(result.input_tokens).toBe(0);
  expect(result.output_tokens).toBe(0);
  expect(result.cost_usd).toBe(0);
  expect(result.story_count).toBe(0);
});

test('readSpendWindow skips malformed lines without throwing', () => {
  const rootDir = tmpRoot();
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });

  const line1 = JSON.stringify({
    at: '2026-05-19T10:00:00.000Z',
    story_id: 'STORY-A',
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.0006
  });
  const line2 = 'this is not valid json {]';
  const line3 = JSON.stringify({
    at: '2026-05-19T14:00:00.000Z',
    story_id: 'STORY-B',
    input_tokens: 2000,
    output_tokens: 1000,
    cost_usd: 0.0012
  });

  fs.writeFileSync(ledgerPath, [line1, line2, line3].join('\n') + '\n', 'utf8');

  const result = readSpendWindow({
    rootDir,
    since: '2026-05-19T00:00:00.000Z',
    until: '2026-05-20T00:00:00.000Z'
  });

  expect(result.entries.length).toBe(2);
  expect(result.entries[0].story_id).toBe('STORY-A');
  expect(result.entries[1].story_id).toBe('STORY-B');
  expect(result.input_tokens).toBe(3000);
  expect(result.output_tokens).toBe(1500);
  expect(result.cost_usd).toBe(0.0018);
  expect(result.story_count).toBe(2);
});

test('readSpendWindow handles entries with missing at field', () => {
  const rootDir = tmpRoot();
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });

  const line1 = JSON.stringify({
    at: '2026-05-19T10:00:00.000Z',
    story_id: 'STORY-A',
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.0006
  });
  const line2 = JSON.stringify({
    story_id: 'STORY-B',
    input_tokens: 2000,
    output_tokens: 1000,
    cost_usd: 0.0012
  });
  const line3 = JSON.stringify({
    at: '2026-05-19T14:00:00.000Z',
    story_id: 'STORY-C',
    input_tokens: 500,
    output_tokens: 250,
    cost_usd: 0.0003
  });

  fs.writeFileSync(ledgerPath, [line1, line2, line3].join('\n') + '\n', 'utf8');

  const result = readSpendWindow({
    rootDir,
    since: '2026-05-19T00:00:00.000Z',
    until: '2026-05-20T00:00:00.000Z'
  });

  // Should skip line2 (no 'at' field) and include line1 and line3
  expect(result.entries.length).toBe(2);
  expect(result.entries[0].story_id).toBe('STORY-A');
  expect(result.entries[1].story_id).toBe('STORY-C');
  expect(result.input_tokens).toBe(1500);
  expect(result.output_tokens).toBe(750);
  expect(result.cost_usd).toBe(0.0009);
  expect(result.story_count).toBe(2);
});

test('readSpendWindow with no bounds returns all entries', () => {
  const rootDir = tmpRoot();
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });

  const line1 = JSON.stringify({
    at: '2026-05-19T08:00:00.000Z',
    story_id: 'STORY-A',
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.0006
  });
  const line2 = JSON.stringify({
    at: '2026-05-20T14:00:00.000Z',
    story_id: 'STORY-B',
    input_tokens: 2000,
    output_tokens: 1000,
    cost_usd: 0.0012
  });
  const line3 = JSON.stringify({
    at: '2026-05-21T08:00:00.000Z',
    story_id: 'STORY-C',
    input_tokens: 1000,
    output_tokens: 1000,
    cost_usd: 0.001
  });

  fs.writeFileSync(ledgerPath, [line1, line2, line3].join('\n') + '\n', 'utf8');

  const result = readSpendWindow({ rootDir });

  expect(result.entries.length).toBe(3);
  expect(result.input_tokens).toBe(4000);
  expect(result.output_tokens).toBe(2500);
  expect(result.cost_usd).toBe(0.0028);
  expect(result.story_count).toBe(3);
});
