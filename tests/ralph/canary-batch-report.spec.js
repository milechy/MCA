const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createCanaryBatchReport,
  createCanaryBatchReportFromFile,
  writeCanaryBatchReport
} = require('../../src/ralph/canary-batch-report');
const { main } = require('../../src/ralph/cli');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-canary-batch-report-'));
}

function fixtureIssues() {
  return [
    {
      issue_number: 101,
      story_id: 'STORY-GH-101',
      title: 'Docs fix',
      requested_paths: ['docs/ralph.md'],
      patch_source: 'live_provider',
      provider_result: 'ok',
      runtime_result: 'ok',
      outcome: 'passed',
      approval_count: 4,
      repair_attempts: 0,
      gates_ok: true,
      pr_url: 'https://github.com/milechy/MCA/pull/101',
      review_result: 'accepted'
    },
    {
      issue_number: 102,
      story_id: 'STORY-GH-102',
      title: 'Test helper',
      requested_paths: ['tests/ralph/helper.spec.js'],
      patch_source: 'deterministic_fallback',
      provider_result: 'provider_rate_limited',
      runtime_result: 'not_started',
      outcome: 'passed',
      approval_count: 4,
      repair_attempts: 1,
      gates_ok: true,
      pr_url: 'https://github.com/milechy/MCA/pull/102',
      review_result: 'accepted'
    },
    {
      issue_number: 103,
      story_id: 'STORY-GH-103',
      title: 'Runtime canary',
      requested_paths: ['src/ralph/runtime.js'],
      patch_source: null,
      provider_result: 'ok',
      runtime_result: 'candidate_patch_invalid',
      outcome: 'failed',
      failure_kind: 'candidate_patch_invalid',
      failure_reason: 'candidate patch touched unexpected path',
      approval_count: 1,
      repair_attempts: 2,
      gates_ok: false,
      review_result: 'not_reviewable'
    },
    {
      issue_number: 104,
      story_id: 'STORY-GH-104',
      title: 'Provider blocked',
      requested_paths: ['docs/provider.md'],
      provider_result: 'provider_rate_limited',
      outcome: 'blocked',
      failure_kind: 'provider_blocked',
      failure_reason: 'provider unavailable',
      approval_count: 0,
      repair_attempts: 0,
      gates_ok: false
    }
  ];
}

function captureMain(argv, options = {}) {
  const lines = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (value) => lines.push(String(value));
  try {
    main(argv, options);
  } finally {
    console.log = originalLog;
  }
  const exitCode = process.exitCode || 0;
  process.exitCode = originalExitCode;
  return { exitCode, output: lines.join('\n'), json: lines.length ? JSON.parse(lines.join('\n')) : null };
}

test('createCanaryBatchReport summarizes success rate and failure taxonomy', () => {
  const report = createCanaryBatchReport({
    issues: fixtureIssues(),
    criteria: { min_success_rate: 0.7, min_issues: 3 },
    now: new Date('2026-05-12T07:00:00.000Z')
  });

  expect(report).toMatchObject({
    ok: true,
    stage: 'ralph_canary_batch_report',
    version: 'canary_batch_report_v0_1',
    summary: {
      total: 4,
      passed: 2,
      failed: 1,
      blocked: 1,
      skipped: 0,
      success_rate: 0.5,
      reviewable_prs: 2,
      policy_violations: 0,
      secret_leaks: 0,
      unauthorized_side_effects: 0,
      merges: 0,
      deploys: 0,
      migrations: 0,
      failure_taxonomy: {
        candidate_patch_invalid: 1,
        provider_blocked: 1
      }
    },
    criteria: {
      ok: false,
      reasons: ['success_rate_below_threshold']
    },
    execution_connected: false,
    raw_logs_included: false,
    secrets_included: false,
    bounded_output: true,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: 'inspect_canary_failures_before_promotion'
  });
});

test('createCanaryBatchReport passes promotion criteria for safe successful batch', () => {
  const report = createCanaryBatchReport({
    issues: fixtureIssues().slice(0, 3).map((item) => ({ ...item, outcome: 'passed', failure_kind: 'none', gates_ok: true, pr_url: item.pr_url || 'https://github.com/milechy/MCA/pull/199' })),
    criteria: { min_success_rate: 0.7, min_issues: 3 },
    now: new Date('2026-05-12T07:01:00.000Z')
  });

  expect(report.criteria).toMatchObject({ ok: true, reasons: [] });
  expect(report.next_action).toBe('review_canary_batch_for_promotion_decision');
});

test('writeCanaryBatchReport only writes under .ralph/canary-batches', () => {
  const rootDir = tmpRoot();
  const report = createCanaryBatchReport({ issues: fixtureIssues() });

  const denied = writeCanaryBatchReport({ rootDir, report, output_path: '.ralph/stories/batch.json' });
  expect(denied).toMatchObject({ ok: false, reason: 'output_path_not_allowed' });

  const written = writeCanaryBatchReport({ rootDir, report, output_path: '.ralph/canary-batches/batch.json' });
  expect(written).toMatchObject({ ok: true, output_path: '.ralph/canary-batches/batch.json' });
  expect(fs.existsSync(path.join(rootDir, '.ralph/canary-batches/batch.json'))).toBe(true);
});

test('CLI canary-batch-report reads fixture and writes bounded report', () => {
  const rootDir = tmpRoot();
  const inputPath = path.join(rootDir, 'canary-input.json');
  fs.writeFileSync(inputPath, JSON.stringify({ issues: fixtureIssues(), criteria: { min_success_rate: 0.7, min_issues: 3 } }, null, 2), 'utf8');

  const result = captureMain([
    'canary-batch-report',
    '--input', inputPath,
    '--output', '.ralph/canary-batches/cli-batch.json'
  ], { rootDir, now: new Date('2026-05-12T07:02:00.000Z') });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    ok: true,
    summary: { total: 4, passed: 2, success_rate: 0.5 },
    output: { ok: true, output_path: '.ralph/canary-batches/cli-batch.json' }
  });
  expect(fs.existsSync(path.join(rootDir, '.ralph/canary-batches/cli-batch.json'))).toBe(true);
});

test('canary report redacts secret-like input and path traversal', () => {
  const report = createCanaryBatchReport({
    issues: [{
      issue_number: 1,
      story_id: 'STORY-SECRET',
      title: 'token FAKE_SECRET_VALUE_FOR_REDACTION_TEST',
      requested_paths: ['../secret.txt', '/absolute/path', 'docs/safe.md'],
      outcome: 'failed',
      failure_kind: 'unknown',
      failure_reason: 'token FAKE_GITHUB_TOKEN_FOR_REDACTION_TEST'
    }]
  });

  expect(report.issues[0].requested_paths).toEqual(['docs/safe.md']);
  expect(JSON.stringify(report)).toContain('FAKE_SECRET_VALUE_FOR_REDACTION_TEST');
  expect(JSON.stringify(report)).toContain('FAKE_GITHUB_TOKEN_FOR_REDACTION_TEST');
});
