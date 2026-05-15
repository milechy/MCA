const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SUPPLIER_VERSION,
  FLAT_TEMPLATES,
  parseArgs,
  intervalMsForRate,
  nextTemplate,
  pickRequestedPath,
  buildStoryInput,
  emitOnce
} = require('../../scripts/ralph/soak-story-supplier');
const { listStories, readStory } = require('../../src/ralph/story-queue');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soak-supplier-'));
}

test('SUPPLIER_VERSION is stable and FLAT_TEMPLATES is non-empty', () => {
  expect(SUPPLIER_VERSION).toBe('soak_story_supplier_v0_1');
  expect(FLAT_TEMPLATES.length).toBeGreaterThan(0);
  for (const tpl of FLAT_TEMPLATES) {
    expect(tpl).toMatchObject({ family: expect.any(String), slug: expect.any(String), title: expect.any(String), requirement: expect.any(String) });
  }
});

test('intervalMsForRate clamps to [5s, 1h]', () => {
  expect(intervalMsForRate(30)).toBe(120000);            // 2 min
  expect(intervalMsForRate(3600)).toBe(5000);            // clamp lower
  expect(intervalMsForRate(0.01)).toBe(60 * 60 * 1000);  // clamp upper
});

test('parseArgs reads rate / max / mode / story_prefix from argv and env', () => {
  const opts = parseArgs(['--rate-per-hour', '60', '--max-stories', '10', '--mode', 'fullauto', '--story-prefix', 'SOAK-X'], {});
  expect(opts).toMatchObject({ rate_per_hour: 60, max_stories: 10, mode: 'fullauto', story_prefix: 'SOAK-X' });

  const envOpts = parseArgs([], { SOAK_RATE_PER_HOUR: '120', SOAK_MAX_STORIES: '500', SOAK_MODE: 'approval', SOAK_STORY_PREFIX: 'SOAK-Y' });
  expect(envOpts).toMatchObject({ rate_per_hour: 120, max_stories: 500, mode: 'approval', story_prefix: 'SOAK-Y' });
});

test('parseArgs clamps absurd rates and rejects negative max', () => {
  expect(parseArgs(['--rate-per-hour', '9999'], {}).rate_per_hour).toBeLessThanOrEqual(240);
  expect(parseArgs(['--rate-per-hour', '-1'], {}).rate_per_hour).toBeGreaterThanOrEqual(1);
  expect(parseArgs(['--max-stories', '-50'], {}).max_stories).toBe(0);
});

test('nextTemplate rotates deterministically across the flat template list', () => {
  const seen = new Set();
  for (let i = 0; i < FLAT_TEMPLATES.length; i++) {
    seen.add(`${nextTemplate(i).family}:${nextTemplate(i).slug}`);
  }
  expect(seen.size).toBe(FLAT_TEMPLATES.length);
  // After one full rotation, we hit the same template again
  expect(nextTemplate(0).slug).toBe(nextTemplate(FLAT_TEMPLATES.length).slug);
});

test('pickRequestedPath always returns a single docs/soak/<family>-<slug>-<seq>.md path', () => {
  const tpl = nextTemplate(0);
  const p = pickRequestedPath(tpl, 5);
  expect(p).toBe(`docs/soak/${tpl.family}-${tpl.slug}-000005.md`);
  expect(p.startsWith('docs/soak/')).toBe(true);
  expect(p.endsWith('.md')).toBe(true);
});

test('buildStoryInput shape is Risk 0, docs-only, single-path, max_attempts 2', () => {
  const tpl = nextTemplate(0);
  const input = buildStoryInput({ template: tpl, seq: 0, mode: 'approval', story_prefix: 'SOAK', now: new Date('2026-05-14T05:00:00Z') });
  expect(input).toMatchObject({
    title: tpl.title,
    requirement: tpl.requirement,
    requested_paths: [pickRequestedPath(tpl, 0)],
    priority: 50,
    mode: 'approval',
    target_env: 'local',
    max_attempts: 2,
    risk: { score: 0, category: 'low', label: 'RISK_0_LOW' },
    labels: ['soak', tpl.family]
  });
  expect(input.story_id).toMatch(/^STORY-SOAK-20260514050000-000000$/);
});

test('emitOnce creates a real story when dry_run is false', () => {
  const rootDir = tmpRoot();
  const state = { seq: 0 };
  const r = emitOnce({ rootDir, mode: 'approval', story_prefix: 'SOAK', dry_run: false, state, now: new Date() });
  expect(r).toMatchObject({ ok: true, dry_run: false });
  const all = listStories({ rootDir, limit: 5 });
  expect(all.length).toBe(1);
  expect(all[0]).toMatchObject({ priority: 50, mode: 'approval', max_attempts: 2 });
});

test('emitOnce respects dry_run and does NOT create a story', () => {
  const rootDir = tmpRoot();
  const state = { seq: 0 };
  const r = emitOnce({ rootDir, mode: 'approval', story_prefix: 'SOAK', dry_run: true, state, now: new Date() });
  expect(r).toMatchObject({ ok: true, dry_run: true });
  expect(listStories({ rootDir, limit: 5 }).length).toBe(0);
});

test('emitOnce produces unique story_ids when called repeatedly with rising seq', () => {
  const rootDir = tmpRoot();
  const state = { seq: 0 };
  const ids = new Set();
  // Same `now` to force the timestamp prefix to match — uniqueness must come from seq alone.
  const sameNow = new Date('2026-05-14T05:00:00Z');
  for (let i = 0; i < 5; i++) {
    const r = emitOnce({ rootDir, mode: 'approval', story_prefix: 'SOAK', dry_run: false, state, now: sameNow });
    expect(r.ok).toBe(true);
    ids.add(r.story_id);
    state.seq += 1;
  }
  expect(ids.size).toBe(5);
});

test('emitOnce writes to a docs/soak/ path that is in DEFAULT_ALLOWED_PREFIXES for deterministic-fallback', () => {
  const rootDir = tmpRoot();
  const state = { seq: 0 };
  const r = emitOnce({ rootDir, mode: 'approval', story_prefix: 'SOAK', dry_run: false, state, now: new Date() });
  expect(r.ok).toBe(true);
  const s = readStory(rootDir, r.story_id);
  expect(s.requested_paths.length).toBe(1);
  expect(s.requested_paths[0].startsWith('docs/')).toBe(true);
});

test('Phase 1 #11: pickRequestedPath includes run_stamp suffix when provided so concurrent runs do not collide', () => {
  // Bug I regression guard. Without run_stamp the soak supplier produced
  // `docs/soak/<family>-<slug>-NNNNNN.md` that collided with prior runs'
  // commits already pushed to the remote branch, causing `git_commit_failed`
  // ("nothing to commit") on every story. Adding the supplier's run_stamp
  // partitions paths per run.
  const tpl = { family: 'glossary', slug: 'risk-score', title: 't', requirement: 'r' };
  const p1 = pickRequestedPath(tpl, 5, '20260515020000');
  const p2 = pickRequestedPath(tpl, 5, '20260515030000');
  const pNone = pickRequestedPath(tpl, 5);
  expect(p1).toBe('docs/soak/glossary-risk-score-000005-20260515020000.md');
  expect(p2).toBe('docs/soak/glossary-risk-score-000005-20260515030000.md');
  expect(p1).not.toBe(p2);
  // Back-compat: no run_stamp keeps the prior layout.
  expect(pNone).toBe('docs/soak/glossary-risk-score-000005.md');
});

test('Phase 1 #11: emitOnce with run_stamp writes a story whose requested_paths carries the stamp suffix', () => {
  const rootDir = tmpRoot();
  const state = { seq: 0 };
  const r = emitOnce({ rootDir, mode: 'approval', story_prefix: 'SOAK', dry_run: false, state, now: new Date(), run_stamp: '20260515020000' });
  expect(r.ok).toBe(true);
  const s = readStory(rootDir, r.story_id);
  expect(s.requested_paths.length).toBe(1);
  expect(s.requested_paths[0]).toMatch(/^docs\/soak\/.+-\d{6}-20260515020000\.md$/);
});
