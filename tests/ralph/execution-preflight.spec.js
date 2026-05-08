const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { verifyExecutionPreflight } = require('../../src/ralph/execution-preflight');

const EMPTY_DIFF_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-preflight-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'mode.json'), `${JSON.stringify({
    mode: 'approval',
    effective_until: null,
    auto_revert_to: null,
    changed_by: { channel: 'test' },
    policy_version: 'approval-policy-v1.4',
    reason: 'preflight_test',
    updated_at: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
  return rootDir;
}

function samplePlan(overrides = {}) {
  return {
    story_id: 'STORY-PREFLIGHT',
    summary: 'Execution preflight test',
    objective: 'Verify execution preflight without executing work',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_preflight.sql'],
    migration_plan: {
      files: ['supabase/migrations/001_preflight.sql'],
      sql: 'CREATE TABLE preflight_test (id uuid primary key);'
    },
    allowed_user_ids: [123],
    ...overrides
  };
}

function createApprovedRecordOnly(rootDir, plan = samplePlan(), options = {}) {
  const approval = createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: options.approval_id || 'APR-PREFLIGHT',
    allowed_user_ids: [123],
    expires_at: options.expires_at,
    pre_exec_diff_hash: options.pre_exec_diff_hash || EMPTY_DIFF_HASH
  });
  return approveApprovalRecordOnly(approval.approval_id, 123, { rootDir, channel: 'telegram' });
}

test('preflight passes for approved record-only approval with matching hashes', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = verifyExecutionPreflight(approval.approval_id, plan, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(true);
  expect(result.execution_connected).toBe(false);
  expect(result.production_policy.ok).toBe(true);
  expect(result.next_action).toBe('EXECUTION_ALLOWED_BY_PREFLIGHT_ONLY');
});

test('preflight fails when approval is not approved', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: 'APR-PREFLIGHT-PENDING',
    allowed_user_ids: [123],
    pre_exec_diff_hash: EMPTY_DIFF_HASH
  });

  const result = verifyExecutionPreflight(approval.approval_id, plan, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('approval_status_pending');
});

test('preflight fails on plan hash mismatch', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);
  const changedPlan = samplePlan({ objective: 'changed objective' });

  const result = verifyExecutionPreflight(approval.approval_id, changedPlan, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('plan_hash_mismatch');
});

test('preflight fails on diff hash mismatch', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = verifyExecutionPreflight(approval.approval_id, plan, {
    rootDir,
    current_diff_hash: 'sha256:different'
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('pre_exec_diff_hash_mismatch');
});

test('preflight blocks production target through production change policy', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan({ target_env: 'production' });
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = verifyExecutionPreflight(approval.approval_id, plan, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('production_execution_requires_separate_apply_path');
  expect(result.production_policy.plan_approval_required).toBe(true);
  expect(result.production_policy.diff_approval_required).toBe(true);
});

test('preflight blocks risk 5 plan', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan({
    migration_plan: {
      files: ['supabase/migrations/999_drop.sql'],
      sql: 'DROP TABLE users;'
    }
  });
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = verifyExecutionPreflight(approval.approval_id, plan, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('risk_5_execution_blocked');
});

test('preflight blocks post execution diff approval requirement before execution path continues', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan({ target_env: 'staging', planned_files: ['src/foo.js'], migration_plan: { files: [], sql: '' } });
  const approval = createApprovedRecordOnly(rootDir, plan);

  const result = verifyExecutionPreflight(approval.approval_id, plan, {
    rootDir,
    current_diff_hash: EMPTY_DIFF_HASH,
    post_exec_diff_hash_changed: true
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('diff_approval_required_before_execution');
  expect(result.production_policy.diff_approval_required).toBe(true);
});
