const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSpendWindow } = require('../../src/ralph/kimi-cost-tracker');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spend-window-'));
}

function setupLedger(rootDir, entries) {
  const ralphDir = path.join(rootDir, '.ralph');
  fs.mkdirSync(ralphDir, { recursive: true });
  const ledgerPath = path.join(ralphDir, 'cost-ledger.jsonl');
  const lines = entries.map((e) => JSON.stringify(e));
  fs.writeFileSync(ledgerPath, lines.join('\n') + '\n', 'utf8');
  return ledgerPath;
}

test('readSpendWindow filters by both since and until (inclusive)', () => {
  const rootDir = tmpRoot();
  setupLedger(rootDir, [
    {
      at: '2026-05-25T08:00:00.000Z',
      story_id: 'STORY-A',
      model: 'kimi',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0006
    },
    {
      at: '2026-05-25T12:00:00.000Z',
      story_id: 'STORY-B',
      model: 'kimi',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.0012
    },
    {
      at: '2026-05-25T16:00:00.000Z',
      story_id: 'STORY-C',
      model: 'kimi',
      input_tokens: 1500,
      output_tokens: 750,
      cost_usd: 0.0009
    },
    {
      at: '2026-05-26T08:00:00.000Z',
      story_id: 'STORY-D',
      model: 'kimi',
      input_tokens: 500,
      output_tokens: 250,
      cost_usd: 0.0003
    }
  ]);

  const result = readSpendWindow({
    rootDir,
    since: '2026-05-25T10:00:00.000Z',
    until: '2026-05-25T15:00:00.000Z'
  });

  expect(result.entries.length).toBe(1);
  expect(result.entries[0].story_id).toBe('STORY-B');
  expect(result.input_tokens).toBe(2000);
  expect(result.output_tokens).toBe(1000);
  expect(result.cost_usd).toBeCloseTo(0.0012, 6);
  expect(result.story_count).toBe(1);
});

test('readSpendWindow with since only (no upper bound)', () => {
  const rootDir = tmpRoot();
  setupLedger(rootDir, [
    {
      at: '2026-05-25T08:00:00.000Z',
      story_id: 'STORY-A',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0006
    },
    {
      at: '2026-05-25T12:00:00.000Z',
      story_id: 'STORY-B',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.0012
    },
    {
      at: '2026-05-26T08:00:00.000Z',
      story_id: 'STORY-C',
      input_tokens: 1500,
      output_tokens: 750,
      cost_usd: 0.0009
    }
  ]);

  const result = readSpendWindow({
    rootDir,
    since: '2026-05-25T10:00:00.000Z'
  });

  expect(result.entries.length).toBe(2);
  expect(result.entries[0].story_id).toBe('STORY-B');
  expect(result.entries[1].story_id).toBe('STORY-C');
  expect(result.input_tokens).toBe(3500);
  expect(result.output_tokens).toBe(1750);
  expect(result.cost_usd).toBeCloseTo(0.0021, 6);
  expect(result.story_count).toBe(2);
});

test('readSpendWindow with until only (no lower bound)', () => {
  const rootDir = tmpRoot();
  setupLedger(rootDir, [
    {
      at: '2026-05-25T08:00:00.000Z',
      story_id: 'STORY-A',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0006
    },
    {
      at: '2026-05-25T12:00:00.000Z',
      story_id: 'STORY-B',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.0012
    },
    {
      at: '2026-05-26T08:00:00.000Z',
      story_id: 'STORY-C',
      input_tokens: 1500,
      output_tokens: 750,
      cost_usd: 0.0009
    }
  ]);

  const result = readSpendWindow({
    rootDir,
    until: '2026-05-25T15:00:00.000Z'
  });

  expect(result.entries.length).toBe(2);
  expect(result.entries[0].story_id).toBe('STORY-A');
  expect(result.entries[1].story_id).toBe('STORY-B');
  expect(result.input_tokens).toBe(3000);
  expect(result.output_tokens).toBe(1500);
  expect(result.cost_usd).toBeCloseTo(0.0018, 6);
  expect(result.story_count).toBe(2);
});

test('readSpendWindow returns zeros when ledger missing', () => {
  const rootDir = tmpRoot();
  const result = readSpendWindow({
    rootDir,
    since: '2026-05-25T00:00:00.000Z',
    until: '2026-05-26T00:00:00.000Z'
  });

  expect(result.entries.length).toBe(0);
  expect(result.input_tokens).toBe(0);
  expect(result.output_tokens).toBe(0);
  expect(result.cost_usd).toBe(0);
  expect(result.story_count).toBe(0);
});

test('readSpendWindow skips malformed lines without throwing', () => {
  const rootDir = tmpRoot();
  const ralphDir = path.join(rootDir, '.ralph');
  fs.mkdirSync(ralphDir, { recursive: true });
  const ledgerPath = path.join(ralphDir, 'cost-ledger.jsonl');

  const lines = [
    JSON.stringify({
      at: '2026-05-25T08:00:00.000Z',
      story_id: 'STORY-A',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0006
    }),
    'this is not valid json',
    JSON.stringify({
      at: '2026-05-25T12:00:00.000Z',
      story_id: 'STORY-B',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.0012
    }),
    '{incomplete json',
    JSON.stringify({
      at: '2026-05-25T16:00:00.000Z',
      story_id: 'STORY-C',
      input_tokens: 1500,
      output_tokens: 750,
      cost_usd: 0.0009
    })
  ];

  fs.writeFileSync(ledgerPath, lines.join('\n') + '\n', 'utf8');

  const result = readSpendWindow({
    rootDir,
    since: '2026-05-25T00:00:00.000Z',
    until: '2026-05-26T00:00:00.000Z'
  });

  // Should have parsed the 3 valid entries and skipped the 2 malformed ones
  expect(result.entries.length).toBe(3);
  expect(result.input_tokens).toBe(4500);
  expect(result.output_tokens).toBe(2250);
  expect(result.cost_usd).toBeCloseTo(0.0027, 6);
  expect(result.story_count).toBe(3);
});

test('readSpendWindow includes boundary timestamps (inclusive)', () => {
  const rootDir = tmpRoot();
  setupLedger(rootDir, [
    {
      at: '2026-05-25T10:00:00.000Z',
      story_id: 'STORY-A',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0006
    },
    {
      at: '2026-05-25T12:00:00.000Z',
      story_id: 'STORY-B',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.0012
    },
    {
      at: '2026-05-25T15:00:00.000Z',
      story_id: 'STORY-C',
      input_tokens: 1500,
      output_tokens: 750,
      cost_usd: 0.0009
    }
  ]);

  const result = readSpendWindow({
    rootDir,
    since: '2026-05-25T10:00:00.000Z',
    until: '2026-05-25T15:00:00.000Z'
  });

  // All three should be included (boundaries are inclusive)
  expect(result.entries.length).toBe(3);
  expect(result.story_count).toBe(3);
});

test('readSpendWindow counts unique stories correctly', () => {
  const rootDir = tmpRoot();
  setupLedger(rootDir, [
    {
      at: '2026-05-25T08:00:00.000Z',
      story_id: 'STORY-A',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0006
    },
    {
      at: '2026-05-25T09:00:00.000Z',
      story_id: 'STORY-A',
      input_tokens: 500,
      output_tokens: 250,
      cost_usd: 0.0003
    },
    {
      at: '2026-05-25T10:00:00.000Z',
      story_id: 'STORY-B',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.0012
    }
  ]);

  const result = readSpendWindow({
    rootDir,
    since: '2026-05-25T00:00:00.000Z',
    until: '2026-05-26T00:00:00.000Z'
  });

  expect(result.entries.length).toBe(3);
  expect(result.story_count).toBe(2); // Only 2 unique stories
  expect(result.input_tokens).toBe(3500);
  expect(result.output_tokens).toBe(1750);
  expect(result.cost_usd).toBeCloseTo(0.0021, 6);
});

test('readSpendWindow with no since/until returns all entries', () => {
  const rootDir = tmpRoot();
  setupLedger(rootDir, [
    {
      at: '2026-05-25T08:00:00.000Z',
      story_id: 'STORY-A',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0006
    },
    {
      at: '2026-05-26T08:00:00.000Z',
      story_id: 'STORY-B',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.0012
    },
    {
      at: '2026-05-27T08:00:00.000Z',
      story_id: 'STORY-C',
      input_tokens: 1500,
      output_tokens: 750,
      cost_usd: 0.0009
    }
  ]);

  const result = readSpendWindow({ rootDir });

  expect(result.entries.length).toBe(3);
  expect(result.story_count).toBe(3);
  expect(result.input_tokens).toBe(4500);
  expect(result.output_tokens).toBe(2250);
  expect(result.cost_usd).toBeCloseTo(0.0027, 6);
});
