const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sandboxSummaryPath,
  assertSandboxLocalPath,
  runFakeOpenCodeSandbox
} = require('../../src/telegram/opencode-sandbox-runner');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sandbox-runner-'));
}

function passingPreflight(approvalId = 'APR-OPENCODE-SANDBOX-DRY-1') {
  return {
    ok: true,
    start_allowed: true,
    approval_id: approvalId,
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    requested_paths: ['src/foo.js', 'tests/foo.spec.js'],
    execution_connected: false,
    opencode_execution_started: false,
    commands_executed: [],
    files_modified: []
  };
}

test('sandbox dry runner computes summary path inside sandbox only', () => {
  const rootDir = makeRoot();
  const preflight = passingPreflight();
  const summaryPath = sandboxSummaryPath(rootDir, preflight.sandbox_root);

  expect(summaryPath).toContain(path.join('.ralph', 'tmp', 'opencode-sandbox', preflight.approval_id, 'dry-run-summary.json'));
  expect(assertSandboxLocalPath(rootDir, preflight.sandbox_root, summaryPath)).toBe(true);
  expect(assertSandboxLocalPath(rootDir, preflight.sandbox_root, path.join(rootDir, 'src', 'foo.js'))).toBe(false);
});

test('fake OpenCode sandbox runner refuses failed preflight without side effects', () => {
  const rootDir = makeRoot();
  const preflight = { ...passingPreflight(), ok: false, start_allowed: false, reason: 'opencode_sandbox_env_not_enabled' };
  const result = runFakeOpenCodeSandbox(preflight, { rootDir });

  expect(result).toMatchObject({
    ok: false,
    stage: 'opencode_sandbox_dry_execution',
    reason: 'opencode_sandbox_env_not_enabled',
    runner: 'fake_opencode_sandbox_runner',
    preflight_ok: false,
    opencode_execution_started: false,
    real_opencode_process_started: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_preflight_failure'
  });

  expect(fs.existsSync(path.join(rootDir, preflight.sandbox_root))).toBe(false);
});

test('fake OpenCode sandbox runner writes only sandbox-local summary and never starts real OpenCode', () => {
  const rootDir = makeRoot();
  const preflight = passingPreflight();
  const times = [new Date('2026-05-07T00:00:00.000Z'), new Date('2026-05-07T00:00:01.250Z')];
  const result = runFakeOpenCodeSandbox(preflight, { rootDir, now: () => times.shift() || new Date('2026-05-07T00:00:01.250Z') });

  const expectedSummary = `.ralph/tmp/opencode-sandbox/${preflight.approval_id}/dry-run-summary.json`;
  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_sandbox_dry_execution',
    reason: null,
    runner: 'fake_opencode_sandbox_runner',
    approval_id: preflight.approval_id,
    sandbox_root: preflight.sandbox_root,
    started_at: '2026-05-07T00:00:00.000Z',
    finished_at: '2026-05-07T00:00:01.250Z',
    duration_ms: 1250,
    preflight_ok: true,
    opencode_execution_started: false,
    real_opencode_process_started: false,
    commands_executed: [],
    files_modified: [expectedSummary],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'review_sandbox_dry_run_summary_then_consider_phase12_7_real_opencode'
  });

  const summaryPath = path.join(rootDir, expectedSummary);
  expect(fs.existsSync(summaryPath)).toBe(true);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary).toMatchObject({
    runner: 'fake_opencode_sandbox_runner',
    approval_id: preflight.approval_id,
    sandbox_root: preflight.sandbox_root,
    requested_paths: ['src/foo.js', 'tests/foo.spec.js'],
    real_opencode_process_started: false,
    commands_executed: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});
