const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { APPROVAL_TYPES, APPROVAL_STATUSES } = require('../../src/ralph/types');
const { readApproval } = require('../../src/ralph/approval-manager');
const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const { candidatePatchPath, previewOpenCodeCandidatePatch } = require('../../src/telegram/opencode-patch-preview');
const {
  defaultPatchApprovalId,
  calculatePatchHash,
  makePatchApprovalPlan,
  createOpenCodePatchPreviewApproval
} = require('../../src/telegram/opencode-patch-approval');

function gitCommit(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: rootDir, stdio: 'ignore' });
}

function makeGitRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-patch-approval-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-patch-approval'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  gitCommit(rootDir, 'init');
  return rootDir;
}

function writeCandidatePatch(rootDir, approvalId, content) {
  const sandboxRoot = `.ralph/tmp/opencode-sandbox/${approvalId}`;
  const patchPath = candidatePatchPath(rootDir, sandboxRoot);
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, content);
  gitCommit(rootDir, `candidate patch ${approvalId}`);
  return { sandboxRoot, patchPath };
}

const TEST_DIFF = `diff --git a/src/foo.js b/src/foo.js
index 1111111..2222222 100644
--- a/src/foo.js
+++ b/src/foo.js
@@ -1,2 +1,3 @@
 export const oldValue = true;
+export const newValue = true;
`;

test('defaultPatchApprovalId is deterministic for timestamp', () => {
  expect(defaultPatchApprovalId(new Date('2026-05-07T12:34:56.789Z'))).toBe('APR-OPENCODE-PATCH-20260507123456');
});

test('calculatePatchHash reads only sandbox-local candidate patch', () => {
  const rootDir = makeGitRepo();
  const approvalId = 'APR-OPENCODE-PATCH-APPROVAL-1';
  const { sandboxRoot } = writeCandidatePatch(rootDir, approvalId, TEST_DIFF);
  const preview = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot });

  expect(calculatePatchHash(rootDir, preview)).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(calculatePatchHash(rootDir, { ...preview, candidate_patch_path: 'candidate.patch' })).toBe(null);
});

test('makePatchApprovalPlan preserves apply-disabled metadata', () => {
  const preview = {
    approval_id: 'APR-1',
    candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-1/candidate.patch',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-1',
    files_touched: ['src/foo.js'],
    risk: { score: 1, label: 'RISK_1_LOCAL_SOURCE_PREVIEW', category: 'low' }
  };
  const plan = makePatchApprovalPlan(preview, 'sha256:abc');

  expect(plan).toMatchObject({
    story_id: 'STORY-APR-1',
    requested_action: 'opencode_candidate_patch_apply',
    patch_hash: 'sha256:abc',
    files_touched: ['src/foo.js'],
    apply_allowed: false,
    execution_connected: false
  });
});

test('createOpenCodePatchPreviewApproval writes pending diff approval without applying patch', () => {
  const rootDir = makeGitRepo();
  const approvalId = 'APR-OPENCODE-PATCH-APPROVAL-2';
  const { sandboxRoot } = writeCandidatePatch(rootDir, approvalId, TEST_DIFF);
  const preview = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot });

  const result = createOpenCodePatchPreviewApproval(preview, {
    rootDir,
    approval_id: 'APR-PATCH-APPROVAL-EXPLICIT',
    allowed_user_ids: [3],
    now: new Date('2026-05-07T00:00:00.000Z'),
    expires_at: '2026-05-07T00:30:00.000Z'
  });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    stage: 'opencode_patch_preview_approval',
    approval_id: 'APR-PATCH-APPROVAL-EXPLICIT',
    approval_type: APPROVAL_TYPES.DIFF,
    status: APPROVAL_STATUSES.PENDING,
    requested_action: 'opencode_candidate_patch_apply',
    preview_ok: true,
    requires_approval: true,
    apply_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'approve_or_deny_patch_preview_before_any_apply_phase'
  });
  expect(result.patch_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(result.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(result.pre_apply_diff_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

  const approval = readApproval(rootDir, 'APR-PATCH-APPROVAL-EXPLICIT');
  expect(approval).toMatchObject({
    approval_id: 'APR-PATCH-APPROVAL-EXPLICIT',
    approval_type: APPROVAL_TYPES.DIFF,
    status: APPROVAL_STATUSES.PENDING,
    requested_action: 'opencode_candidate_patch_apply',
    allowed_user_ids: [3],
    patch_hash: result.patch_hash,
    candidate_patch_path: `.ralph/tmp/opencode-sandbox/${approvalId}/candidate.patch`,
    sandbox_root: sandboxRoot,
    files_touched: ['src/foo.js'],
    requires_approval: true,
    apply_allowed: false,
    execution_connected: false,
    future_apply_requires_patch_hash: true,
    future_apply_requires_pre_apply_diff_hash: true,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('createOpenCodePatchPreviewApproval fails closed for invalid previews', () => {
  const rootDir = makeGitRepo();
  expect(createOpenCodePatchPreviewApproval(null, { rootDir }).reason).toBe('candidate_preview_required');
  expect(createOpenCodePatchPreviewApproval({ ok: false }, { rootDir }).reason).toBe('candidate_preview_not_ok');
  expect(createOpenCodePatchPreviewApproval({ ok: true, requires_approval: false, apply_allowed: false }, { rootDir }).reason).toBe('candidate_preview_does_not_require_approval');
  expect(createOpenCodePatchPreviewApproval({ ok: true, requires_approval: true, apply_allowed: true }, { rootDir }).reason).toBe('candidate_preview_apply_must_be_disabled');
  expect(createOpenCodePatchPreviewApproval({ ok: true, requires_approval: true, apply_allowed: false, risk: { score: 5 } }, { rootDir }).reason).toBe('candidate_preview_blocked_risk');
  expect(createOpenCodePatchPreviewApproval({ ok: true, requires_approval: true, apply_allowed: false, risk: { score: 1 }, candidate_patch_path: 'missing.patch', sandbox_root: '.ralph/tmp/opencode-sandbox/APR' }, { rootDir }).reason).toBe('patch_hash_unavailable');
});

test('/opencode-patch-approval handler creates pending approval and remains execution-disconnected', () => {
  const rootDir = makeGitRepo();
  const approvalId = 'APR-OPENCODE-PATCH-APPROVAL-3';
  const { sandboxRoot, patchPath } = writeCandidatePatch(rootDir, approvalId, TEST_DIFF);
  const relativePatchPath = path.relative(rootDir, patchPath).replace(/\\/g, '/');

  const result = handleTelegramCommand(
    parseTelegramCommand(`/opencode-patch-approval ${approvalId} ${sandboxRoot} ${relativePatchPath} APR-PATCH-HANDLER-1`),
    {
      rootDir,
      user_id: 3,
      now: new Date('2026-05-07T00:00:00.000Z'),
      roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
    }
  );

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.apply_allowed).toBe(false);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.approval_id).toBe('APR-PATCH-HANDLER-1');
  expect(result.summary.approval_type).toBe(APPROVAL_TYPES.DIFF);
  expect(result.summary.status).toBe(APPROVAL_STATUSES.PENDING);
  expect(result.summary.apply_allowed).toBe(false);
  expect(result.summary.commands_executed).toEqual([]);
  expect(result.summary.repository_files_modified).toEqual([]);
  expect(result.text).toContain('OpenCode patch preview approval requested. Patch apply remains disabled.');
});
