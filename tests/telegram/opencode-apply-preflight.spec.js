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

test('Phase 1 #9 (I): pre_apply_diff_hash mismatch is downgraded to informational when patch still applies cleanly (Bug F regression)', () => {
  // Bug F scenario: between DIFF-approval creation and APPLY execution, the
  // diff hash drifted (e.g. approval was created while another story had a
  // dirty working tree from its own mid-APPLY state; by the time our APPLY
  // runs, that story has COMMITed and the tree is clean again — so the
  // recorded pre_exec_diff_hash no longer equals the live hash). Previously
  // the strict equality check escalated us with pre_apply_diff_hash_mismatch
  // even though our patch (touching unrelated files) still applies cleanly.
  // With the Phase 1 #9 (I) semantic check, the preflight passes and records
  // the drift in pre_apply_diff_hash_changed for observability.
  const rootDir = makeGitRepo();
  const { approval } = makeApprovedPatchApproval(rootDir);
  // Simulate the drift by overwriting the approval's pre_exec_diff_hash with
  // a fake non-matching value. This is the equivalent of the live hash
  // having drifted between approval creation and APPLY.
  const driftedApproval = { ...approval, pre_exec_diff_hash: 'sha256:0000drifted0000drifted0000drifted0000drifted0000drifted0000drift' };
  writeApprovalFile(rootDir, driftedApproval);

  const result = approvedOpenCodeApplyPreflight({ rootDir, approval_id: driftedApproval.approval_id, patch_hash: driftedApproval.patch_hash });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe(null);
  expect(result.pre_apply_diff_hash_changed).toBe(true);
  expect(result.expected_pre_apply_diff_hash).toBe(driftedApproval.pre_exec_diff_hash);
  expect(result.pre_apply_diff_hash).not.toBe(driftedApproval.pre_exec_diff_hash);
  expect(result.apply_check_ok).toBe(true);
  expect(result.apply_check_stderr_preview).toBe(null);
  expect(result.apply_allowed).toBe(true);
});

test('Phase 1 #9 (I): preflight blocks candidate_patch_does_not_apply_cleanly when patch genuinely cannot apply', () => {
  // When the patch genuinely conflicts with the live tree (e.g. another
  // story already created the same target file), we surface a clean
  // descriptive failure with the git stderr preview rather than the
  // misleading pre_apply_diff_hash_mismatch.
  const rootDir = makeGitRepo();
  const { approval } = makeApprovedPatchApproval(rootDir);
  // The PATCH_TEXT creates a NEW file at tests/opencode-generated.spec.js.
  // Pretend another story already created that file (forcing a conflict).
  fs.mkdirSync(path.join(rootDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'tests/opencode-generated.spec.js'), 'pre-existing content from another story\n');
  gitCommit(rootDir, 'collision: same target file created by another story');

  const result = approvedOpenCodeApplyPreflight({ rootDir, approval_id: approval.approval_id, patch_hash: approval.patch_hash });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('candidate_patch_does_not_apply_cleanly');
  expect(result.apply_check_ok).toBe(false);
  expect(typeof result.apply_check_stderr_preview).toBe('string');
  expect(result.apply_check_stderr_preview.length).toBeGreaterThan(0);
  expect(result.apply_allowed).toBe(false);
});

test('Phase 1 #9 (I): preflight exposes pre_apply_diff_hash + expected_pre_apply_diff_hash on success even when unchanged', () => {
  // Observability contract: the happy path always reports both hashes and
  // the changed flag so dashboards/logs can verify the check ran.
  const rootDir = makeGitRepo();
  const { approval } = makeApprovedPatchApproval(rootDir);
  const result = approvedOpenCodeApplyPreflight({ rootDir, approval_id: approval.approval_id, patch_hash: approval.patch_hash });
  expect(result.ok).toBe(true);
  expect(result.pre_apply_diff_hash_changed).toBe(false);
  expect(result.pre_apply_diff_hash).toBe(approval.pre_exec_diff_hash);
  expect(result.expected_pre_apply_diff_hash).toBe(approval.pre_exec_diff_hash);
  expect(result.apply_check_ok).toBe(true);
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
