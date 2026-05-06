const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApproval, approveApproval, supersedeApprovalForModify } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-approval-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '', 'utf8');
  return rootDir;
}

function samplePlan(overrides = {}) {
  return {
    story_id: 'STORY-TEST',
    summary: 'Add staging migration',
    objective: 'Create a staging-only migration',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_add_table.sql'],
    migration_plan: {
      files: ['supabase/migrations/001_add_table.sql'],
      sql: 'CREATE TABLE demo (id uuid primary key);'
    },
    allowed_user_ids: [123456789],
    ...overrides
  };
}

test('approval succeeds for an allowed user and unchanged plan', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const risk = evaluateRisk(plan);

  const approval = createApproval(plan, risk, {
    rootDir,
    approval_id: 'APR-TEST-ALLOW',
    allowed_user_ids: [123456789]
  });

  const approved = approveApproval(approval.approval_id, 123456789, plan, { rootDir });

  expect(approved.status).toBe('approved');
  expect(approved.approved_by).toBe('cli:123456789');
});

test('approval fails for a disallowed user', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const risk = evaluateRisk(plan);

  const approval = createApproval(plan, risk, {
    rootDir,
    approval_id: 'APR-TEST-DENY',
    allowed_user_ids: [123456789]
  });

  const result = approveApproval(approval.approval_id, 999, plan, { rootDir });

  expect(result.status).toBe('failed_verification');
  expect(result.status_details.reason).toBe('user_not_allowed');
});

test('approval fails when plan hash changes', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const risk = evaluateRisk(plan);

  const approval = createApproval(plan, risk, {
    rootDir,
    approval_id: 'APR-TEST-HASH',
    allowed_user_ids: [123456789]
  });

  const modifiedPlan = samplePlan({ objective: 'Changed objective after approval request' });
  const result = approveApproval(approval.approval_id, 123456789, modifiedPlan, { rootDir });

  expect(result.status).toBe('failed_verification');
  expect(result.status_details.reason).toBe('plan_hash_mismatch');
});

test('modify supersedes the current approval and requires replan', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const risk = evaluateRisk(plan);

  const approval = createApproval(plan, risk, {
    rootDir,
    approval_id: 'APR-TEST-MODIFY',
    allowed_user_ids: [123456789]
  });

  const result = supersedeApprovalForModify(approval.approval_id, 'Limit DB changes to staging only', { rootDir });

  expect(result.status).toBe('superseded');
  expect(result.status_details.next_action).toBe('REPLAN_REQUIRED');
  expect(result.modify_instruction).toBe('Limit DB changes to staging only');
});
