const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { verifyShellDryRunPreflight, runShellDryRunWithPreflight } = require('../../src/ralph/shell-preflight-wrapper');

const EMPTY_DIFF_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-preflight-wrapper-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'mode.json'), `${JSON.stringify({
    mode: 'approval',
    effective_until: null,
    auto_revert_to: null,
    changed_by: { channel: 'test' },
    policy_version: 'approval-policy-v1.4',
    reason: 'shell_preflight_wrapper_test',
    updated_at: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
  return rootDir;
}

function samplePlan(overrides = {}) {
  return {
    story_id: 'STORY-SHELL-PREFLIGHT',
    summary: 'Shell preflight wrapper test',
    objective: 'Validate shell dry-run requires approval preflight and command allowlist',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_shell_preflight.sql'],
    migration_plan: {
      files: ['supabase/migrations/001_shell_preflight.sql'],
      sql: 'CREATE TABLE shell_preflight_test (id uuid primary key);'
    },
    allowed_user_ids: [123],
    ...overrides
  };
}

function createApprovedRecordOnly(rootDir, plan = samplePlan()) {
  const approval = createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: 'APR-SHELL-PREFLIGHT',
    allowed_user_ids: [123],
    pre_exec_diff_hash: EMPTY_DIFF_HASH
  });
  return approveApprovalRecordOnly(approval.approval_id, 123, { rootDir, channel: 'telegram' });
}

const allowlistedCommand = {
  command: 'scripts/gates/run-all.sh',
  args: [],
  cwd: '.'
};

test('shell dry-run preflight passes when approval and command allowlist pass', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = verifyShellDryRunPreflight(approval.approval_id, plan, allowlistedCommand, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(true);
  expect(result.next_action).toBe('SHELL_DRY_RUN_ALLOWED_BY_PREFLIGHT_ONLY');
  expect(result.execution_connected).toBe(false);
  expect(result.command_preflight.command_hash).toMatch(/^sha256:/);
});

test('shell dry-run preflight fails when execution preflight fails', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);
  const changedPlan = samplePlan({ objective: 'changed objective' });

  const result = verifyShellDryRunPreflight(approval.approval_id, changedPlan, allowlistedCommand, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(false);
  expect(result.stage).toBe('execution_preflight');
  expect(result.reason).toBe('plan_hash_mismatch');
});

test('shell dry-run preflight fails when command is not allowlisted', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = verifyShellDryRunPreflight(approval.approval_id, plan, {
    command: 'npm',
    args: ['test'],
    cwd: '.'
  }, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(false);
  expect(result.stage).toBe('command_allowlist');
  expect(result.reason).toBe('command_not_allowlisted');
});

test('runShellDryRunWithPreflight validates and logs without executing commands', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = runShellDryRunWithPreflight(approval.approval_id, plan, allowlistedCommand, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(true);
  expect(result.execution_connected).toBe(false);
  expect(result.commands_executed).toEqual([]);
  expect(result.files_modified).toEqual([]);
  expect(result.shell_dry_run.executor).toBe('shell-dry-run');
  expect(result.log.event).toBe('shell_dry_run_with_preflight_completed');
});
