const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { runApprovedShellCommand } = require('../../src/ralph/shell-approved-executor');

const EMPTY_DIFF_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-approved-executor-'));
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
    reason: 'shell_approved_executor_test',
    updated_at: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
  return rootDir;
}

function samplePlan(overrides = {}) {
  return {
    story_id: 'STORY-SHELL-APPROVED',
    summary: 'Approved shell executor test',
    objective: 'Verify approved shell execution remains policy-gated',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_shell_approved.sql'],
    migration_plan: {
      files: ['supabase/migrations/001_shell_approved.sql'],
      sql: 'CREATE TABLE shell_approved_test (id uuid primary key);'
    },
    allowed_user_ids: [123],
    ...overrides
  };
}

function createApprovedRecordOnly(rootDir, plan = samplePlan()) {
  const approval = createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: 'APR-SHELL-APPROVED',
    allowed_user_ids: [123],
    pre_exec_diff_hash: EMPTY_DIFF_HASH
  });
  return approveApprovalRecordOnly(approval.approval_id, 123, { rootDir, channel: 'telegram' });
}

const gatesCommand = {
  command: 'scripts/gates/run-all.sh',
  args: [],
  cwd: '.'
};

test('approved shell command is blocked by production dry-run-only allowlist', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = runApprovedShellCommand(approval.approval_id, plan, gatesCommand, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH,
    allow_real_execution: true
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('allowlist_entry_is_dry_run_only');
  expect(result.stage).toBe('shell_execution_policy');
  expect(result.commands_executed).toEqual([]);
  expect(result.files_modified).toEqual([]);
  expect(result.log.event).toBe('approved_shell_execution_blocked');
});

test('approved shell command is blocked before command policy when execution preflight fails', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);
  const changedPlan = samplePlan({ objective: 'changed objective' });

  const result = runApprovedShellCommand(approval.approval_id, changedPlan, gatesCommand, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH,
    allow_real_execution: true
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('plan_hash_mismatch');
  expect(result.stage).toBe('execution_preflight');
  expect(result.commands_executed).toEqual([]);
  expect(result.files_modified).toEqual([]);
  expect(result.log.event).toBe('approved_shell_execution_blocked');
});
