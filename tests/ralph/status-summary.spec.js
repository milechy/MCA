const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildStatusSummary,
  formatStatusSummaryTable,
  formatStatusSummaryJson
} = require('../../src/ralph/status-summary');
const { parseArgs, runStatus } = require('../../scripts/ralph/status');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'status-summary-'));
}

// ============================================================
// parseArgs
// ============================================================

test('Phase 5 #6: parseArgs reads --json and --root, ignores unknown flags', () => {
  expect(parseArgs([])).toMatchObject({ json: false });
  expect(parseArgs(['--json'])).toMatchObject({ json: true });
  expect(parseArgs(['--root', '/tmp/x']).root).toBe('/tmp/x');
  expect(parseArgs(['--unknown', 'value', '--json']).json).toBe(true);
});

test('Phase 5 #6: parseArgs default root is process.cwd()', () => {
  const args = parseArgs([]);
  expect(args.root).toBe(process.cwd());
});

// ============================================================
// buildStatusSummary
// ============================================================

test('Phase 5 #6: buildStatusSummary returns ok:false on missing rootDir', () => {
  const s = buildStatusSummary({ now: new Date() });
  expect(s.ok).toBe(false);
  expect(s.reason).toBe('rootdir_required');
});

test('Phase 5 #6: buildStatusSummary aggregates counts per status', () => {
  const listStories = () => [
    { story_id: 'A', title: 't', status: 'queued', current_phase: 'PLAN' },
    { story_id: 'B', title: 't', status: 'running', current_phase: 'OPENCODE_RUNNING' },
    { story_id: 'C', title: 't', status: 'running', current_phase: 'GATES' },
    { story_id: 'D', title: 't', status: 'waiting_approval', current_phase: 'DIFF_APPROVAL_PENDING' },
    { story_id: 'E', title: 't', status: 'completed', current_phase: 'DONE' },
    { story_id: 'F', title: 't', status: 'failed', current_phase: 'ESCALATED' },
    { story_id: 'G', title: 't', status: 'stopped', current_phase: 'STOPPED' }
  ];
  const summary = buildStatusSummary({
    rootDir: '/tmp',
    now: new Date('2026-05-26T00:00:00Z'),
    listStories,
    loadMode: () => ({ mode: 'approval' }),
    readDailySpend: () => ({ cost_usd: 0.5 }),
    dailyBudgetCap: () => 5
  });
  expect(summary.ok).toBe(true);
  expect(summary.counts.queued).toBe(1);
  expect(summary.counts.running).toBe(2);
  expect(summary.counts.waiting_approval).toBe(1);
  expect(summary.counts.completed).toBe(1);
  expect(summary.counts.failed).toBe(1);
  expect(summary.counts.stopped).toBe(1);
  expect(summary.counts.total).toBe(7);
});

test('Phase 5 #6: buildStatusSummary sorts running/waiting first, then queued, then completed, then failed', () => {
  const listStories = () => [
    { story_id: 'X-done', status: 'completed', updated_at: '2026-05-26T00:00:00Z' },
    { story_id: 'X-running', status: 'running', updated_at: '2026-05-25T00:00:00Z' },
    { story_id: 'X-queued', status: 'queued', updated_at: '2026-05-25T12:00:00Z' },
    { story_id: 'X-failed', status: 'failed', updated_at: '2026-05-26T00:00:00Z' }
  ];
  const summary = buildStatusSummary({
    rootDir: '/tmp',
    now: new Date('2026-05-26T01:00:00Z'),
    listStories,
    loadMode: () => ({ mode: 'approval' }),
    readDailySpend: () => ({ cost_usd: 0 }),
    dailyBudgetCap: () => 5
  });
  const ids = summary.stories.map((s) => s.story_id);
  // running comes first, then queued, then completed, then failed
  expect(ids[0]).toBe('X-running');
  expect(ids[1]).toBe('X-queued');
  expect(ids[2]).toBe('X-done');
  expect(ids[3]).toBe('X-failed');
});

test('Phase 5 #6: buildStatusSummary surfaces fullauto expiry as mode.expired=true', () => {
  const now = new Date('2026-05-26T12:00:00Z');
  const summary = buildStatusSummary({
    rootDir: '/tmp',
    now,
    listStories: () => [],
    loadMode: () => ({ mode: 'fullauto', effective_until: '2026-05-26T11:00:00Z' }),
    readDailySpend: () => ({ cost_usd: 0 }),
    dailyBudgetCap: () => 5
  });
  expect(summary.mode.mode).toBe('fullauto');
  expect(summary.mode.expired).toBe(true);
});

test('Phase 5 #6: buildStatusSummary handles loadMode throwing — mode.error=mode_unavailable', () => {
  const summary = buildStatusSummary({
    rootDir: '/tmp',
    now: new Date(),
    listStories: () => [],
    loadMode: () => { throw new Error('boom'); },
    readDailySpend: () => ({ cost_usd: 0 }),
    dailyBudgetCap: () => 5
  });
  expect(summary.ok).toBe(true);
  expect(summary.mode.mode).toBeNull();
  expect(summary.mode.error).toBe('mode_unavailable');
});

test('Phase 5 #6: buildStatusSummary handles readDailySpend throwing — cost.error=cost_unavailable', () => {
  const summary = buildStatusSummary({
    rootDir: '/tmp',
    now: new Date(),
    listStories: () => [],
    loadMode: () => ({ mode: 'approval' }),
    readDailySpend: () => { throw new Error('disk gone'); },
    dailyBudgetCap: () => 5
  });
  expect(summary.ok).toBe(true);
  expect(summary.cost.error).toBe('cost_unavailable');
});

test('Phase 5 #6: buildStatusSummary surfaces last_verdict + last_repair_instruction_present', () => {
  const listStories = () => [
    { story_id: 'A', status: 'completed', last_review_result: { verdict: 'approve' }, last_repair_instruction: null },
    { story_id: 'B', status: 'running', last_review_result: null, last_repair_instruction: 'fix this' },
    { story_id: 'C', status: 'running' }
  ];
  const summary = buildStatusSummary({
    rootDir: '/tmp',
    now: new Date(),
    listStories,
    loadMode: () => ({ mode: 'approval' }),
    readDailySpend: () => ({ cost_usd: 0 }),
    dailyBudgetCap: () => 5
  });
  const byId = Object.fromEntries(summary.stories.map((s) => [s.story_id, s]));
  expect(byId.A.last_verdict).toBe('approve');
  expect(byId.A.last_repair_instruction_present).toBe(false);
  expect(byId.B.last_verdict).toBeNull();
  expect(byId.B.last_repair_instruction_present).toBe(true);
  expect(byId.C.last_verdict).toBeNull();
  expect(byId.C.last_repair_instruction_present).toBe(false);
});

test('Phase 5 #6: buildStatusSummary caps stories at 25 entries', () => {
  const listStories = () => Array.from({ length: 40 }, (_, i) => ({
    story_id: `S${i}`,
    status: 'running',
    current_phase: 'OPENCODE_RUNNING',
    updated_at: `2026-05-26T00:${String(i).padStart(2, '0')}:00Z`
  }));
  const summary = buildStatusSummary({
    rootDir: '/tmp',
    now: new Date('2026-05-26T01:00:00Z'),
    listStories,
    loadMode: () => ({ mode: 'approval' }),
    readDailySpend: () => ({ cost_usd: 0 }),
    dailyBudgetCap: () => 5
  });
  expect(summary.counts.running).toBe(40);
  expect(summary.stories).toHaveLength(25);
});

// ============================================================
// formatStatusSummaryTable
// ============================================================

test('Phase 5 #6: formatStatusSummaryTable renders mode + cost + counts + stories', () => {
  const summary = {
    ok: true,
    checked_at: '2026-05-26T00:00:00.000Z',
    counts: { queued: 1, running: 2, waiting_approval: 1, completed: 0, failed: 0, stopped: 0, total: 4 },
    stories: [
      { story_id: 'R1', status: 'running', current_phase: 'OPENCODE_RUNNING', attempts: 1, max_attempts: 3 },
      { story_id: 'R2', status: 'running', current_phase: 'GATES', attempts: 0, max_attempts: 3, pr_number: 7, last_verdict: 'comment' }
    ],
    mode: { mode: 'fullauto', effective_until: '2026-05-26T01:00:00.000Z', expires_in_ms: 60 * 60 * 1000, expired: false },
    cost: { daily_spend: 0.12, daily_cap: 5, fraction: 0.024, paused_at_cap: false }
  };
  const text = formatStatusSummaryTable(summary);
  expect(text).toContain('Ralph status');
  expect(text).toContain('Mode:');
  expect(text).toContain('fullauto');
  expect(text).toContain('Cost: $0.12');
  expect(text).toContain('$5');
  expect(text).toContain('Counts:');
  expect(text).toContain('1 queued');
  expect(text).toContain('2 running');
  expect(text).toContain('Stories:');
  expect(text).toContain('R1');
  expect(text).toContain('R2');
  expect(text).toContain('PR #7');
  expect(text).toContain('verdict=comment');
});

test('Phase 5 #6: formatStatusSummaryTable handles empty stories', () => {
  const summary = {
    ok: true, checked_at: '2026-05-26T00:00:00.000Z',
    counts: { queued: 0, running: 0, waiting_approval: 0, completed: 0, failed: 0, stopped: 0, total: 0 },
    stories: [],
    mode: { mode: 'approval', expired: false },
    cost: { daily_spend: 0, daily_cap: 5, fraction: 0, paused_at_cap: false }
  };
  expect(formatStatusSummaryTable(summary)).toContain('Stories: (none queued)');
});

test('Phase 5 #6: formatStatusSummaryTable shows EXPIRED when fullauto past its effective_until', () => {
  const summary = {
    ok: true, checked_at: '2026-05-26T00:00:00.000Z',
    counts: { queued: 0, running: 0, waiting_approval: 0, completed: 0, failed: 0, stopped: 0, total: 0 },
    stories: [],
    mode: { mode: 'fullauto', effective_until: '2026-05-25T00:00:00Z', expires_in_ms: -86400000, expired: true },
    cost: { error: 'cost_unavailable' }
  };
  const text = formatStatusSummaryTable(summary);
  expect(text).toContain('fullauto EXPIRED at 2026-05-25T00:00:00Z');
  expect(text).toContain('Cost: unavailable');
});

// ============================================================
// formatStatusSummaryJson
// ============================================================

test('Phase 5 #6: formatStatusSummaryJson returns valid 2-space indented JSON', () => {
  const summary = { ok: true, checked_at: 't', counts: { queued: 0 }, stories: [], mode: {}, cost: {} };
  const text = formatStatusSummaryJson(summary);
  expect(typeof text).toBe('string');
  expect(JSON.parse(text)).toEqual(summary);
  expect(text).toContain('\n  ');  // 2-space indent
});

// ============================================================
// runStatus CLI
// ============================================================

test('Phase 5 #6: runStatus prints table by default and JSON with --json flag', async () => {
  // Use a real fs root with no .ralph/stories — exercises real listStories.
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.ralph'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ralph', 'mode.json'), JSON.stringify({ mode: 'approval' }));
  const tableOut = [];
  const tableErr = [];
  let tableExit = null;
  await runStatus({
    argv: ['--root', root],
    stdout: (s) => tableOut.push(s),
    stderr: (s) => tableErr.push(s),
    exit: (c) => { tableExit = c; },
    now: new Date('2026-05-26T00:00:00Z')
  });
  expect(tableExit).toBe(0);
  expect(tableOut.join('')).toContain('Ralph status');
  expect(tableOut.join('')).toContain('Stories: (none queued)');

  const jsonOut = [];
  await runStatus({
    argv: ['--root', root, '--json'],
    stdout: (s) => jsonOut.push(s),
    stderr: () => {},
    exit: () => {},
    now: new Date('2026-05-26T00:00:00Z')
  });
  const parsed = JSON.parse(jsonOut.join(''));
  expect(parsed.ok).toBe(true);
  expect(parsed.counts.total).toBe(0);
});

test('Phase 5 #6: runStatus reads real .ralph/stories/*.json and surfaces them', async () => {
  const root = tmpRoot();
  const storiesDir = path.join(root, '.ralph', 'stories');
  fs.mkdirSync(storiesDir, { recursive: true });
  fs.writeFileSync(path.join(storiesDir, 'STORY-A.json'), JSON.stringify({
    story_id: 'STORY-A',
    title: 'demo',
    status: 'running',
    current_phase: 'OPENCODE_RUNNING',
    attempts: 1,
    max_attempts: 3
  }));
  fs.writeFileSync(path.join(root, '.ralph', 'mode.json'), JSON.stringify({ mode: 'approval' }));

  const out = [];
  let exitCode = null;
  await runStatus({
    argv: ['--root', root, '--json'],
    stdout: (s) => out.push(s),
    stderr: () => {},
    exit: (c) => { exitCode = c; },
    now: new Date('2026-05-26T00:00:00Z')
  });
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(out.join(''));
  expect(parsed.counts.running).toBe(1);
  expect(parsed.stories[0].story_id).toBe('STORY-A');
});
