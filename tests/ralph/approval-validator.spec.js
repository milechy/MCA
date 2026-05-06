const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dryRunApprovalCommand } = require('../../src/ralph/approval-validator');

function makeTempRoot(approval) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-validator-'));
  const pendingDir = path.join(rootDir, '.ralph', 'approval-pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  if (approval) {
    fs.writeFileSync(path.join(pendingDir, `${approval.approval_id}.json`), `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  }
  return rootDir;
}

function sampleApproval(overrides = {}) {
  return {
    approval_id: 'APR-VALIDATOR-001',
    approval_type: 'plan',
    story_id: 'STORY-VALIDATOR',
    status: 'pending',
    risk: { score: 3, category: 'db', label: 'RISK_3_DB', requires_approval: true },
    requested_action: 'require_plan_approval',
    allowed_user_ids: [123],
    plan_summary: 'validator test',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    plan_hash: 'sha256:plan',
    pre_exec_diff_hash: 'sha256:diff',
    ...overrides
  };
}

test('dry-run approval command passes for pending approval and allowed user', () => {
  const approval = sampleApproval();
  const rootDir = makeTempRoot(approval);

  const result = dryRunApprovalCommand('approve', approval.approval_id, 123, { rootDir });

  expect(result.ok).toBe(true);
  expect(result.runtime_mutation).toBe(false);
  expect(result.approval.approval_id).toBe(approval.approval_id);
});

test('dry-run approval command fails when approval is missing', () => {
  const rootDir = makeTempRoot();

  const result = dryRunApprovalCommand('approve', 'APR-MISSING', 123, { rootDir });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('approval_not_found');
});

test('dry-run approval command fails for disallowed user', () => {
  const approval = sampleApproval();
  const rootDir = makeTempRoot(approval);

  const result = dryRunApprovalCommand('approve', approval.approval_id, 999, { rootDir });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('user_not_allowed');
});

test('dry-run approval command fails for expired approval', () => {
  const approval = sampleApproval({ expires_at: new Date(Date.now() - 60_000).toISOString() });
  const rootDir = makeTempRoot(approval);

  const result = dryRunApprovalCommand('approve', approval.approval_id, 123, { rootDir });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('approval_expired');
});
