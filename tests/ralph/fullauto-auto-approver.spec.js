const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AUTOAPPROVER_VERSION,
  FULLAUTO_AUTO_APPROVABLE_TYPES,
  readModeSafely,
  maybeAutoApproveForFullauto
} = require('../../src/ralph/fullauto-auto-approver');
const { createApproval, readApproval } = require('../../src/ralph/approval-manager');
const { APPROVAL_STATUSES, APPROVAL_TYPES } = require('../../src/ralph/types');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fullauto-auto-approver-'));
}

function seedMode(rootDir, mode) {
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, '.ralph', 'mode.json'),
    JSON.stringify(mode, null, 2)
  );
}

function seedApproval(rootDir, opts = {}) {
  const approvalId = opts.approval_id || 'APR-FA-TEST';
  const plan = { story_id: 'STORY-X', objective: 'noop', requested_paths: [] };
  const risk = opts.risk || { score: 0, category: 'low', label: 'RISK_0_LOW', requires_approval: true };
  const created = createApproval(plan, risk, {
    rootDir,
    approval_id: approvalId,
    approval_type: opts.approval_type || APPROVAL_TYPES.DIFF,
    requested_action: 'opencode_candidate_patch',
    allowed_user_ids: [],
    expires_at: opts.expires_at || new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  expect(created.approval_id).toBe(approvalId);
  return approvalId;
}

test('readModeSafely returns approval when no mode file exists', () => {
  const root = tmpRoot();
  expect(readModeSafely(root)).toMatchObject({ mode: 'approval', expired: false });
});

test('readModeSafely returns fullauto when configured and within window', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  expect(readModeSafely(root)).toMatchObject({ mode: 'fullauto', expired: false });
});

test('readModeSafely reverts expired fullauto to approval', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() - 60_000).toISOString() });
  expect(readModeSafely(root)).toMatchObject({ mode: 'approval', expired: true, was_fullauto: true });
});

test('FULLAUTO_AUTO_APPROVABLE_TYPES covers diff/commit/push/pr but NOT plan', () => {
  expect(FULLAUTO_AUTO_APPROVABLE_TYPES.has(APPROVAL_TYPES.DIFF)).toBe(true);
  expect(FULLAUTO_AUTO_APPROVABLE_TYPES.has('commit')).toBe(true);
  expect(FULLAUTO_AUTO_APPROVABLE_TYPES.has('push')).toBe(true);
  expect(FULLAUTO_AUTO_APPROVABLE_TYPES.has('pr')).toBe(true);
  expect(FULLAUTO_AUTO_APPROVABLE_TYPES.has(APPROVAL_TYPES.PLAN)).toBe(false);
});

test('maybeAutoApproveForFullauto refuses when mode is approval', () => {
  const root = tmpRoot();
  const apId = seedApproval(root);
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: false, reason: 'mode_not_fullauto' });
  expect(readApproval(root, apId).status).toBe(APPROVAL_STATUSES.PENDING);
});

test('maybeAutoApproveForFullauto auto-approves a low-risk diff approval in fullauto mode', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  const apId = seedApproval(root, { approval_type: APPROVAL_TYPES.DIFF, risk: { score: 1 } });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: true, reason: 'fullauto_auto_approved', version: AUTOAPPROVER_VERSION });
  expect(readApproval(root, apId).status).toBe(APPROVAL_STATUSES.APPROVED);
});

test('maybeAutoApproveForFullauto refuses to auto-approve plan approval even in fullauto', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  const apId = seedApproval(root, { approval_type: APPROVAL_TYPES.PLAN, risk: { score: 1 } });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: false, reason: 'approval_type_plan_requires_human' });
  expect(readApproval(root, apId).status).toBe(APPROVAL_STATUSES.PENDING);
});

test('maybeAutoApproveForFullauto refuses Risk 5 (security stop) under any mode', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  const apId = seedApproval(root, { approval_type: APPROVAL_TYPES.DIFF, risk: { score: 5 } });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: false, reason: 'risk_5_security_stop' });
  expect(readApproval(root, apId).status).toBe(APPROVAL_STATUSES.PENDING);
});

test('maybeAutoApproveForFullauto refuses Risk >= 4 in fullauto (still needs human)', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  const apId = seedApproval(root, { approval_type: APPROVAL_TYPES.DIFF, risk: { score: 4 } });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: false, reason: 'fullauto_high_risk_threshold' });
});

test('maybeAutoApproveForFullauto refuses production target_env when risk >= 3', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  const apId = seedApproval(root, { approval_type: APPROVAL_TYPES.DIFF, risk: { score: 3 } });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'production' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: false, reason: 'production_high_risk_requires_human' });
});

test('maybeAutoApproveForFullauto refuses expired approvals', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  const apId = seedApproval(root, {
    approval_type: APPROVAL_TYPES.DIFF,
    risk: { score: 1 },
    expires_at: new Date(Date.now() - 60_000).toISOString()
  });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: false, reason: 'approval_expired' });
});

test('maybeAutoApproveForFullauto refuses when fullauto has expired', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() - 60_000).toISOString() });
  const apId = seedApproval(root, { approval_type: APPROVAL_TYPES.DIFF, risk: { score: 1 } });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: false, reason: 'fullauto_expired_revert_to_approval' });
  expect(readApproval(root, apId).status).toBe(APPROVAL_STATUSES.PENDING);
});

test('maybeAutoApproveForFullauto is a no-op when story has no current_approval_id', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  const r = maybeAutoApproveForFullauto({ rootDir: root, story: { story_id: 'STORY-X', current_approval_id: null } });
  expect(r).toMatchObject({ ok: true, approved: false, reason: 'no_pending_approval' });
});

test('maybeAutoApproveForFullauto reports already_approved for re-entrant calls', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  const apId = seedApproval(root, { approval_type: APPROVAL_TYPES.DIFF, risk: { score: 1 } });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  // First call approves
  expect(maybeAutoApproveForFullauto({ rootDir: root, story }).approved).toBe(true);
  // Second call notices already approved and does not corrupt the record
  const r2 = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r2).toMatchObject({ ok: true, approved: false, reason: 'already_approved' });
  expect(readApproval(root, apId).status).toBe(APPROVAL_STATUSES.APPROVED);
});

const { deriveGateKind } = require('../../src/ralph/fullauto-auto-approver');

test('deriveGateKind maps legacy approval_id prefixes to gate kinds', () => {
  expect(deriveGateKind({ approval_id: 'APR-OPENCODE-APPLY-X', approval_type: 'diff' })).toBe('diff');
  expect(deriveGateKind({ approval_id: 'APR-OPENCODE-COMMIT-X', approval_type: 'diff' })).toBe('diff');
  // The bug case: push approval stamped with approval_type='plan' but its real gate is push
  expect(deriveGateKind({ approval_id: 'APR-OPENCODE-PUSH-X', approval_type: 'plan' })).toBe('push');
  expect(deriveGateKind({ approval_id: 'APR-OPENCODE-PR-X', approval_type: 'plan' })).toBe('pr');
  // Unknown prefix falls through to literal approval_type
  expect(deriveGateKind({ approval_id: 'APR-OTHER-X', approval_type: 'plan' })).toBe('plan');
});

test('maybeAutoApproveForFullauto auto-approves a legacy-plan-typed push approval via prefix', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  // Simulate the legacy approval shape: approval_type='plan' but id prefix is PUSH
  const apId = seedApproval(root, {
    approval_id: 'APR-OPENCODE-PUSH-LEGACY-001',
    approval_type: APPROVAL_TYPES.PLAN,
    risk: { score: 1 }
  });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: true, reason: 'fullauto_auto_approved' });
  expect(readApproval(root, apId).status).toBe(APPROVAL_STATUSES.APPROVED);
});

test('maybeAutoApproveForFullauto still refuses a true PLAN approval (no PUSH/PR prefix)', () => {
  const root = tmpRoot();
  seedMode(root, { mode: 'fullauto', effective_until: new Date(Date.now() + 60_000).toISOString() });
  const apId = seedApproval(root, {
    approval_id: 'APR-PLAN-REAL-001',
    approval_type: APPROVAL_TYPES.PLAN,
    risk: { score: 1 }
  });
  const story = { story_id: 'STORY-X', current_approval_id: apId, target_env: 'local' };
  const r = maybeAutoApproveForFullauto({ rootDir: root, story });
  expect(r).toMatchObject({ ok: true, approved: false, reason: 'approval_type_plan_requires_human' });
});
