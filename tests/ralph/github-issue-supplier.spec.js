const { test, expect } = require('@playwright/test');

const {
  SUPPLIER_VERSION,
  shouldPullIssuesThisCycle,
  supplierOptionsFromEnv,
  boundedSupplierResult,
  tickIssueSupplier
} = require('../../src/ralph/github-issue-supplier');

test('shouldPullIssuesThisCycle returns false when interval is 0 or invalid', () => {
  expect(shouldPullIssuesThisCycle(1, 0)).toBe(false);
  expect(shouldPullIssuesThisCycle(1, -5)).toBe(false);
  expect(shouldPullIssuesThisCycle(1, null)).toBe(false);
  expect(shouldPullIssuesThisCycle(0, 5)).toBe(false);
});

test('shouldPullIssuesThisCycle fires on cycle 1 and every Nth cycle thereafter', () => {
  expect(shouldPullIssuesThisCycle(1, 5)).toBe(true);
  expect(shouldPullIssuesThisCycle(2, 5)).toBe(false);
  expect(shouldPullIssuesThisCycle(5, 5)).toBe(false);
  expect(shouldPullIssuesThisCycle(6, 5)).toBe(true);
  expect(shouldPullIssuesThisCycle(11, 5)).toBe(true);
});

test('shouldPullIssuesThisCycle clamps absurdly large intervals', () => {
  expect(shouldPullIssuesThisCycle(1, 999_999)).toBe(true);
  expect(shouldPullIssuesThisCycle(2, 999_999)).toBe(false);
});

test('supplierOptionsFromEnv reads RALPH_GITHUB_REPO / labels / pull cadence', () => {
  const opts = supplierOptionsFromEnv({
    RALPH_GITHUB_REPO: 'owner/repo',
    RALPH_GITHUB_READY_LABELS: 'ralph-ready, autonomous, ops',
    RALPH_ISSUE_PULL_EVERY_CYCLES: '7',
    RALPH_ISSUE_PULL_MAX: '25'
  });
  expect(opts).toMatchObject({
    repo: 'owner/repo',
    ready_labels: ['ralph-ready', 'autonomous', 'ops'],
    pull_every_cycles: 7,
    max_issues: 25
  });
});

test('supplierOptionsFromEnv defaults to no pull when env is empty', () => {
  expect(supplierOptionsFromEnv({})).toMatchObject({
    repo: null,
    pull_every_cycles: 0,
    max_issues: 50
  });
});

test('supplierOptionsFromEnv clamps and validates numeric inputs', () => {
  const negative = supplierOptionsFromEnv({ RALPH_ISSUE_PULL_EVERY_CYCLES: '-3', RALPH_ISSUE_PULL_MAX: '0' });
  expect(negative.pull_every_cycles).toBe(0);
  expect(negative.max_issues).toBe(50);

  const huge = supplierOptionsFromEnv({ RALPH_ISSUE_PULL_EVERY_CYCLES: '999999', RALPH_ISSUE_PULL_MAX: '10000' });
  expect(huge.pull_every_cycles).toBeLessThanOrEqual(1440);
  expect(huge.max_issues).toBe(100);
});

test('tickIssueSupplier skips when pull_every_cycles is 0', async () => {
  let called = 0;
  const result = await tickIssueSupplier({
    cycle: 1,
    env: {},
    options: { pull_every_cycles: 0 },
    importFn: async () => { called += 1; return { ok: true }; }
  });
  expect(called).toBe(0);
  expect(result).toMatchObject({
    ok: true,
    stage: 'github_issue_supplier_skip',
    version: SUPPLIER_VERSION,
    reason: 'pull_not_due_this_cycle',
    pulled: false
  });
});

test('tickIssueSupplier reports github_repo_not_configured when pull is due but repo is missing', async () => {
  let called = 0;
  const result = await tickIssueSupplier({
    cycle: 1,
    env: {},
    options: { pull_every_cycles: 3, repo: null },
    importFn: async () => { called += 1; return { ok: true }; }
  });
  expect(called).toBe(0);
  expect(result).toMatchObject({
    ok: false,
    reason: 'github_repo_not_configured',
    pulled: false,
    next_action: 'set_RALPH_GITHUB_REPO_or_GITHUB_REPOSITORY'
  });
});

test('tickIssueSupplier invokes importFn with bounded summary on success', async () => {
  let captured = null;
  const fakeImport = async (opts) => {
    captured = opts;
    return {
      ok: true,
      stage: 'github_issue_provider_import',
      repo: opts.repo,
      fetched_count: 3,
      eligible_count: 2,
      imported: [{ story_id: 'STORY-GH-1' }, { story_id: 'STORY-GH-2' }],
      skipped: [{ issue_number: 99, reason: 'label_filter_not_matched' }],
      next_action: 'run_autonomous_scheduler_tick'
    };
  };
  const result = await tickIssueSupplier({
    cycle: 1,
    env: { RALPH_GITHUB_REPO: 'owner/repo' },
    options: { pull_every_cycles: 5, repo: 'owner/repo', ready_labels: ['ralph-ready'], max_issues: 10 },
    importFn: fakeImport
  });
  expect(captured).toMatchObject({
    repo: 'owner/repo',
    readyLabels: ['ralph-ready'],
    maxIssues: 10,
    mode: 'approval',
    target_env: 'local'
  });
  expect(result).toMatchObject({
    ok: true,
    pulled: true,
    repo: 'owner/repo',
    summary: {
      ok: true,
      repo: 'owner/repo',
      imported_count: 2,
      imported_story_ids: ['STORY-GH-1', 'STORY-GH-2'],
      skipped_count: 1,
      next_action: 'run_autonomous_scheduler_tick'
    }
  });
});

test('tickIssueSupplier captures import errors without throwing', async () => {
  const result = await tickIssueSupplier({
    cycle: 1,
    env: {},
    options: { pull_every_cycles: 3, repo: 'owner/repo' },
    importFn: async () => { throw new Error('github_issue_fetch_failed_502'); }
  });
  expect(result).toMatchObject({
    ok: false,
    stage: 'github_issue_supplier_error',
    reason: 'github_issue_fetch_failed_502',
    pulled: true,
    next_action: 'inspect_github_issue_supplier_failure'
  });
});

test('boundedSupplierResult bounds imported/skipped lists', () => {
  const imported = Array.from({ length: 40 }, (_, idx) => ({ story_id: `STORY-GH-${idx}` }));
  const skipped = Array.from({ length: 30 }, (_, idx) => ({ story_id: null, issue_number: idx, reason: 'duplicate' }));
  const bounded = boundedSupplierResult({
    ok: true,
    stage: 'x',
    repo: 'r',
    fetched_count: 99,
    eligible_count: 50,
    imported,
    skipped,
    next_action: 'next'
  });
  expect(bounded.imported_count).toBe(40);
  expect(bounded.imported_story_ids).toHaveLength(25);
  expect(bounded.skipped_count).toBe(30);
  expect(bounded.skipped_preview).toHaveLength(10);
});
