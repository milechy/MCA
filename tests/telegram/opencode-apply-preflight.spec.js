const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { approveApprovalRecordOnly, readApproval } = require('../../src/ralph/approval-manager');
const { APPROVAL_TYPES, APPROVAL_STATUSES } = require('../../src/ralph/types');
const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const { candidatePatchPath, previewOpenCodeCandidatePatch } = require('../../src/telegram/opencode-patch-preview');
const { createOpenCodePatchPreviewApproval } = require('../../src/telegram/opencode-patch-approval');
const { approvedOpenCodeApplyPreflight } = require('../../src/telegram/opencode-apply-preflight');

const PATCH_TEXT = [
  'diff --git a/tests/opencode-generated.spec.js b/tests/opencode-generated.spec.js',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/tests/opencode-generated.spec.js',
  '@@ -0,0 +1,2 @@',
  '+const value = true;',
  '+module.exports = value;',
  ''
].join('\n');

function gitCommit(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: rootDir, stdio: 'ignore' });
}

function makeGitRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-apply-preflight-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-apply-preflight'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  gitCommit(rootDir, 'init');
  return rootDir;
}

function writeApprovalFile(rootDir, approval) {
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${approval.approval_id}.json`), `${JSON.stringify(approval, null, 2)}\n`);
}

function makeApprovedPatchApproval(rootDir, approvalId = 'APR-APPLY-PREFLIGHT-1') {
  const sandboxRoot = `.ralph/tmp/opencode-sandbox/${approvalId}`;
  const patchPath = candidatePatchPath(rootDir, sandboxRoot);
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, PATCH_TEXT);
  gitCommit(rootDir, 'candidate patch');
  const preview = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot });
  const created = createOpenCodePatchPreviewApproval(preview, {
    rootDir,
    approval_id: 'APR-PATCH-APPLY-PREFLIGHT',
    allowed_user_ids: [3],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  approveApprovalRecordOnly(created.approval_id, 3, { rootDir });
  return { created, approval: readApproval(rootDir, created.approval_id), preview, patchPath };
}

test('parseTelegramCommand parses /opencode-apply-preflight', () => {
  const parsed = parseTelegramCommand('/opencode-apply-preflight APR-1 sha256:abc');
  expect(parsed.type).toBe('opencode_apply_preflight');
  expect(parsed.args).toEqual(['APR-1', 'sha256:abc']);
});

test('approvedOpenCodeApplyPreflight passes approved diff approval without changing files', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeApprovedPatchApproval(rootDir);
  const result = approvedOpenCodeApplyPreflight({ rootDir, approval_id: approval.approval_id, patch_hash: approval.patch_hash });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_apply_preflight',
    reason: null,
    approval_id: approval.approval_id,
    approval_type: APPROVAL_TYPES.DIFF,
    status: APPROVAL_STATUSES.APPROVED,
    requested_action: 'opencode_candidate_patch_apply',
    candidate_patch_path: approval.candidate_patch_path,
    sandbox_root: approval.sandbox_root,
    patch_hash: approval.patch_hash,
    pre_apply_diff_hash: approval.pre_exec_diff_hash,
    files_touched: ['tests/opencode-generated.spec.js'],
    apply_allowed: true,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('approvedOpenCodeApplyPreflight blocks invalid states', () => {
  const rootDir = makeGitRepo();
  const { approval, patchPath } = makeApprovedPatchApproval(rootDir);

  expect(approvedOpenCodeApplyPreflight({ rootDir }).reason).toBe('approval_id_required');
  expect(approvedOpenCodeApplyPreflight({ rootDir, approval_id: 'missing' }).reason).toBe('approval_not_found');
  expect(approvedOpenCodeApplyPreflight({ rootDir, approval_id: approval.approval_id, patch_hash: 'sha256:nope' }).reason).toBe('patch_hash_mismatch');

  const pending = { ...approval, approval_id: 'APR-PENDING', status: APPROVAL_STATUSES.PENDING };
  writeApprovalFile(rootDir, pending);
  expect(approvedOpenCodeApplyPreflight({ rootDir, approval_id: 'APR-PENDING', patch_hash: pending.patch_hash }).reason).toBe('approval_not_approved');

  const wrongType = { ...approval, approval_id: 'APR-WRONG-TYPE', approval_type: APPROVAL_TYPES.PLAN };
  writeApprovalFile(rootDir, wrongType);
  expect(approvedOpenCodeApplyPreflight({ rootDir, approval_id: 'APR-WRONG-TYPE', patch_hash: wrongType.patch_hash }).reason).toBe('approval_type_not_diff');

  const wrongAction = { ...approval, approval_id: 'APR-WRONG-ACTION', requested_action: 'other' };
  writeApprovalFile(rootDir, wrongAction);
  expect(approvedOpenCodeApplyPreflight({ rootDir, approval_id: 'APR-WRONG-ACTION', patch_hash: wrongAction.patch_hash }).reason).toBe('requested_action_not_apply');

  fs.rmSync(patchPath);
  expect(approvedOpenCodeApplyPreflight({ rootDir, approval_id: approval.approval_id, patch_hash: approval.patch_hash }).reason).toBe('candidate_patch_missing');
});

test('approvedOpenCodeApplyPreflight blocks dirty repo before file change step', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeApprovedPatchApproval(rootDir);
  fs.writeFileSync(path.join(rootDir, 'dirty.txt'), 'dirty');
  expect(approvedOpenCodeApplyPreflight({ rootDir, approval_id: approval.approval_id, patch_hash: approval.patch_hash }).reason).toBe('pre_apply_diff_hash_mismatch');
});

test('/opencode-apply-preflight handler returns non-mutating apply-ready summary', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeApprovedPatchApproval(rootDir);
  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-apply-preflight ${approval.approval_id} ${approval.patch_hash}`), {
    rootDir,
    user_id: 3,
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.apply_allowed).toBe(true);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.apply_allowed).toBe(true);
  expect(result.summary.commands_executed).toEqual([]);
  expect(result.summary.repository_files_modified).toEqual([]);
});
