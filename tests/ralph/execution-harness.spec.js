const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { runExecutionHarness } = require('../../src/ralph/execution-harness');

const EMPTY_DIFF_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-harness-'));
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
    reason: 'execution_harness_test',
    updated_at: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
  return rootDir;
}

function samplePlan(overrides = {}) {
  return {
    story_id: 'STORY-HARNESS',
    summary: 'Execution harness test',
    objective: 'Verify no-op execution harness without executing work',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_harness.sql'],
    migration_plan: {
      files: ['supabase/migrations/001_harness.sql'],
      sql: 'CREATE TABLE harness_test (id uuid primary key);'
    },
    allowed_user_ids: [123],
    ...overrides
  };
}

function createApprovedRecordOnly(rootDir, plan = samplePlan()) {
  const approval = createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: 'APR-HARNESS',
    allowed_user_ids: [123],
    pre_exec_diff_hash: EMPTY_DIFF_HASH
  });
  return approveApprovalRecordOnly(approval.approval_id, 123, { rootDir, channel: 'telegram' });
}

test('no-op execution harness runs only after successful preflight', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = runExecutionHarness(approval.approval_id, plan, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(true);
  expect(result.executor).toBe('noop');
  expect(result.commands_executed).toEqual([]);
  expect(result.files_modified).toEqual([]);
  expect(result.execution_connected).toBe(false);
  expect(result.log.event).toBe('execution_noop_completed');
});

test('execution harness fails when preflight fails', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);
  const changedPlan = samplePlan({ objective: 'changed objective' });

  const result = runExecutionHarness(approval.approval_id, changedPlan, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('plan_hash_mismatch');
  expect(result.log.event).toBe('execution_preflight_failed');
});

test('execution harness blocks non-noop executor in phase 3.0', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = runExecutionHarness(approval.approval_id, plan, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH,
    executor: 'shell'
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('only_noop_executor_allowed_in_phase_3_0');
  expect(result.log.event).toBe('execution_executor_blocked');
});
