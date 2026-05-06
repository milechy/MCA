const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { isAllowedTmpPlanPath, executeNoopFromTelegram, EMPTY_DIFF_HASH } = require('../../src/telegram/execution-adapter');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-execution-adapter-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'mode.json'), `${JSON.stringify({
    mode: 'approval',
    effective_until: null,
    auto_revert_to: null,
    changed_by: { channel: 'test' },
    policy_version: 'approval-policy-v1.4',
    reason: 'telegram_execution_adapter_test',
    updated_at: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
  return rootDir;
}

function samplePlan(overrides = {}) {
  return {
    story_id: 'STORY-TELEGRAM-EXECUTE-NOOP',
    summary: 'Telegram execute noop test',
    objective: 'Verify Telegram execute-noop remains no-op',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_execute_noop.sql'],
    migration_plan: {
      files: ['supabase/migrations/001_execute_noop.sql'],
      sql: 'CREATE TABLE execute_noop_test (id uuid primary key);'
    },
    allowed_user_ids: [123],
    ...overrides
  };
}

function writePlan(rootDir, plan = samplePlan(), fileName = 'execute-noop-plan.json') {
  const relativePath = `.ralph/tmp/${fileName}`;
  fs.writeFileSync(path.join(rootDir, relativePath), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return relativePath;
}

function createApprovedApproval(rootDir, plan = samplePlan()) {
  const approval = createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: 'APR-TELEGRAM-EXECUTE-NOOP',
    allowed_user_ids: [123],
    pre_exec_diff_hash: EMPTY_DIFF_HASH
  });
  return approveApprovalRecordOnly(approval.approval_id, 123, { rootDir, channel: 'telegram' });
}

test('isAllowedTmpPlanPath only allows .ralph/tmp json files', () => {
  expect(isAllowedTmpPlanPath('.ralph/tmp/plan.json')).toBe(true);
  expect(isAllowedTmpPlanPath('.ralph/tmp/plan-1_test.json')).toBe(true);
  expect(isAllowedTmpPlanPath('/tmp/plan.json')).toBe(false);
  expect(isAllowedTmpPlanPath('../plan.json')).toBe(false);
  expect(isAllowedTmpPlanPath('.ralph/tmp/../plan.json')).toBe(false);
  expect(isAllowedTmpPlanPath('supabase/config.toml')).toBe(false);
  expect(isAllowedTmpPlanPath('.ralph/tmp/plan.txt')).toBe(false);
});

test('executeNoopFromTelegram rejects disallowed plan path', () => {
  const rootDir = makeTempRoot();
  const result = executeNoopFromTelegram('APR-1', '../plan.json', { rootDir });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('plan_path_not_allowed');
});

test('executeNoopFromTelegram rejects missing plan file', () => {
  const rootDir = makeTempRoot();
  const result = executeNoopFromTelegram('APR-1', '.ralph/tmp/missing.json', { rootDir });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('plan_file_not_found');
});

test('executeNoopFromTelegram runs no-op execution after approval and preflight', () => {
  const rootDir = makeTempRoot();
  const plan = samplePlan();
  const approval = createApprovedApproval(rootDir, plan);
  const planPath = writePlan(rootDir, plan);

  const result = executeNoopFromTelegram(approval.approval_id, planPath, { rootDir });

  expect(result.ok).toBe(true);
  expect(result.executor).toBe('noop');
  expect(result.execution_connected).toBe(false);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.commands_executed).toEqual([]);
  expect(result.files_modified).toEqual([]);
  expect(result.log.event).toBe('execution_noop_completed');
});
