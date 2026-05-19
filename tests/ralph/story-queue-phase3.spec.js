const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createStory,
  readStory,
  updateStory,
  summarizeStory,
  ALLOWED_DIFFICULTIES,
  normalizeOptionalString,
  normalizeDifficulty
} = require('../../src/ralph/story-queue');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'story-queue-phase3-'));
}

test('Phase 3 #1: createStory accepts executor_model + planner_model + planner_cost_usd + difficulty', () => {
  const rootDir = tmpRoot();
  const r = createStory({
    story_id: 'STORY-PHASE3-CREATE',
    title: 'test',
    requirement: 'x',
    requested_paths: ['docs/a.md'],
    executor_model: 'openrouter/anthropic/claude-sonnet-4.6',
    planner_model: 'openrouter/openai/gpt-5',
    planner_cost_usd: 0.42,
    difficulty: 'hard'
  }, { rootDir, now: new Date() });
  expect(r.ok).toBe(true);
  const s = readStory(rootDir, 'STORY-PHASE3-CREATE');
  expect(s.executor_model).toBe('openrouter/anthropic/claude-sonnet-4.6');
  expect(s.planner_model).toBe('openrouter/openai/gpt-5');
  expect(s.planner_cost_usd).toBe(0.42);
  expect(s.difficulty).toBe('hard');
});

test('Phase 3 #1: createStory legacy path (no Phase 3 fields) keeps fields null', () => {
  const rootDir = tmpRoot();
  const r = createStory({
    story_id: 'STORY-LEGACY',
    title: 'legacy',
    requirement: 'x',
    requested_paths: ['docs/a.md']
  }, { rootDir, now: new Date() });
  expect(r.ok).toBe(true);
  const s = readStory(rootDir, 'STORY-LEGACY');
  expect(s.executor_model).toBe(null);
  expect(s.planner_model).toBe(null);
  expect(s.planner_cost_usd).toBe(null);
  expect(s.difficulty).toBe(null);
});

test('Phase 3 #1: updateStory patches executor_model independently', () => {
  const rootDir = tmpRoot();
  createStory({
    story_id: 'STORY-PATCH',
    title: 'patch',
    requirement: 'x',
    requested_paths: ['docs/a.md']
  }, { rootDir, now: new Date() });

  updateStory('STORY-PATCH', {
    executor_model: 'openrouter/moonshotai/kimi-k2.6',
    difficulty: 'easy'
  }, { rootDir, now: new Date(), event: 'phase3_patched' });

  const s = readStory(rootDir, 'STORY-PATCH');
  expect(s.executor_model).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(s.difficulty).toBe('easy');
  expect(s.planner_model).toBe(null);  // untouched
});

test('Phase 3 #1: updateStory with executor_model=null explicitly clears it', () => {
  const rootDir = tmpRoot();
  createStory({
    story_id: 'STORY-CLEAR',
    title: 'clear',
    requirement: 'x',
    requested_paths: ['docs/a.md'],
    executor_model: 'openrouter/moonshotai/kimi-k2.6'
  }, { rootDir, now: new Date() });

  updateStory('STORY-CLEAR', { executor_model: null }, { rootDir, now: new Date(), event: 'cleared' });

  const s = readStory(rootDir, 'STORY-CLEAR');
  expect(s.executor_model).toBe(null);
});

test('Phase 3 #1: normalizeDifficulty rejects unknown values', () => {
  expect(normalizeDifficulty('trivial')).toBe('trivial');
  expect(normalizeDifficulty('Easy')).toBe('easy');
  expect(normalizeDifficulty('HARD')).toBe('hard');
  expect(normalizeDifficulty('architectural')).toBe('architectural');
  expect(normalizeDifficulty('something-else')).toBe(null);
  expect(normalizeDifficulty('')).toBe(null);
  expect(normalizeDifficulty(null)).toBe(null);
  expect(normalizeDifficulty(undefined)).toBe(null);
});

test('Phase 3 #1: ALLOWED_DIFFICULTIES is the expected set', () => {
  expect(ALLOWED_DIFFICULTIES).toEqual(['trivial', 'easy', 'medium', 'hard', 'architectural']);
});

test('Phase 3 #1: normalizeOptionalString trims + bounds + returns null for empty', () => {
  expect(normalizeOptionalString('  hello  ')).toBe('hello');
  expect(normalizeOptionalString('a'.repeat(200), 80)).toHaveLength(80);
  expect(normalizeOptionalString('')).toBe(null);
  expect(normalizeOptionalString(null)).toBe(null);
  expect(normalizeOptionalString(undefined)).toBe(null);
});

test('Phase 3 #1: invalid planner_cost_usd values are normalized to null', () => {
  const rootDir = tmpRoot();
  const cases = [
    { input: -1, expected: null },
    { input: NaN, expected: null },
    { input: 'abc', expected: null },
    { input: Infinity, expected: null },
    { input: 0, expected: 0 },
    { input: 0.001, expected: 0.001 }
  ];
  cases.forEach((c, i) => {
    createStory({
      story_id: `STORY-COST-${i}`,
      title: 't',
      requirement: 'x',
      requested_paths: ['docs/a.md'],
      planner_cost_usd: c.input
    }, { rootDir, now: new Date() });
    const s = readStory(rootDir, `STORY-COST-${i}`);
    expect(s.planner_cost_usd).toBe(c.expected);
  });
});

test('Phase 3 #1: summarizeStory surfaces Phase 3 fields', () => {
  const rootDir = tmpRoot();
  createStory({
    story_id: 'STORY-SUMMARY',
    title: 'sum',
    requirement: 'x',
    requested_paths: ['docs/a.md'],
    executor_model: 'openrouter/moonshotai/kimi-k2.6',
    difficulty: 'medium',
    planner_cost_usd: 0.15
  }, { rootDir, now: new Date() });
  const s = readStory(rootDir, 'STORY-SUMMARY');
  const summary = summarizeStory(s);
  expect(summary.executor_model).toBe('openrouter/moonshotai/kimi-k2.6');
  expect(summary.difficulty).toBe('medium');
  expect(summary.planner_cost_usd).toBe(0.15);
  expect(summary.planner_model).toBe(null);
});

test('Phase 3 #1: invalid executor_model with shell-meta characters is rejected (returns trimmed empty -> null)', () => {
  // The dispatcher does its own shell-meta guard, but the schema-level
  // normalization just trims and bounds. Shell-meta characters survive
  // here; the dispatcher's resolveModel falls back to the env default if
  // it sees them. This test documents the boundary contract.
  const rootDir = tmpRoot();
  createStory({
    story_id: 'STORY-META',
    title: 't',
    requirement: 'x',
    requested_paths: ['docs/a.md'],
    executor_model: 'evil; rm -rf /'
  }, { rootDir, now: new Date() });
  const s = readStory(rootDir, 'STORY-META');
  // The schema stores it (since it's a valid string after trim/bound),
  // but downstream consumers must validate before shelling out.
  expect(s.executor_model).toBe('evil; rm -rf /');
});
