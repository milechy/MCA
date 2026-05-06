const { test, expect } = require('@playwright/test');
const { calculatePlanHash, canonicalJson } = require('../../src/ralph/hash');

test('canonical JSON sorts object keys and removes volatile fields', () => {
  const a = {
    updated_at: 'later',
    story_id: 'STORY-1',
    objective: 'Build core',
    nested: { b: 2, a: 1 }
  };
  const b = {
    nested: { a: 1, b: 2 },
    objective: 'Build core',
    story_id: 'STORY-1',
    updated_at: 'now'
  };

  expect(canonicalJson(a)).toBe(canonicalJson(b));
  expect(calculatePlanHash(a)).toBe(calculatePlanHash(b));
});
