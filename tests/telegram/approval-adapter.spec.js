const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApproval } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { approveFromTelegram, denyFromTelegram, modifyFromTelegram } = require('../../src/telegram/approval-adapter');
const { getApproval } = require('../../src/ralph/approval-reader');

const EMPTY_DIFF_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-approval-adapter-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  return rootDir;
}

function samplePlan(overrides = {}) {
  return {
    story_id: 'STORY-TELEGRAM-ADAPTER',
    summary: 'Telegram adapter smoke test',
    objective: 'Validate Telegram approval adapter without execution',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_adapter.sql'],
    migration_plan: {
      files: ['supabase/migrations/001_adapter.sql'],
      sql: 'CREATE TABLE adapter_test (id uuid primary key);'
    },
    allowed_user_ids: [123],
    ...overrides
  };
}

function createTestApproval(rootDir, approvalId, options = {}) {
  const plan = samplePlan();
  return createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: approvalId,
    allowed_user_ids: options.allowed_user_ids || [123],
    expires_at: options.expires_at,
    pre_exec_diff_hash: EMPTY_DIFF_HASH
  });
}

test('approveFromTelegram marks approval approved record-only', () => {
  const rootDir = makeTempRoot();
  const approval = createTestApproval(rootDir, 'APR-TELEGRAM-APPROVE');

  const result = approveFromTelegram(approval.approval_id, 123, { rootDir });
  const stored = getApproval(approval.approval_id, { rootDir });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.execution_requires_hash_verification).toBe(true);
  expect(stored.status).toBe('approved');
  expect(stored.approved_by).toBe('telegram:123');
});

test('approveFromTelegram fails for missing approval', () => {
  const rootDir = makeTempRoot();

  const result = approveFromTelegram('APR-MISSING', 123, { rootDir });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('approval_not_found');
});

test('denyFromTelegram marks approval denied without execution', () => {
  const rootDir = makeTempRoot();
  const approval = createTestApproval(rootDir, 'APR-TELEGRAM-DENY');

  const result = denyFromTelegram(approval.approval_id, 123, { rootDir });
  const stored = getApproval(approval.approval_id, { rootDir });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(stored.status).toBe('denied');
  expect(stored.denied_by).toBe('telegram:123');
});

test('modifyFromTelegram supersedes approval and requires replan without execution', () => {
  const rootDir = makeTempRoot();
  const approval = createTestApproval(rootDir, 'APR-TELEGRAM-MODIFY');

  const result = modifyFromTelegram(approval.approval_id, 123, 'limit to staging only', { rootDir });
  const stored = getApproval(approval.approval_id, { rootDir });

  expect(result.ok).toBe(true);
  expect(result.next_action).toBe('REPLAN_REQUIRED');
  expect(result.wired_to_runtime).toBe(false);
  expect(stored.status).toBe('superseded');
  expect(stored.modify_instruction).toBe('limit to staging only');
  expect(stored.status_details.next_action).toBe('REPLAN_REQUIRED');
});
