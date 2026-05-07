const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { approveApprovalRecordOnly, readApproval } = require('../../src/ralph/approval-manager');
const { APPROVAL_STATUSES } = require('../../src/ralph/types');
const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const { candidatePatchPath, previewOpenCodeCandidatePatch } = require('../../src/telegram/opencode-patch-preview');
const { createOpenCodePatchPreviewApproval } = require('../../src/telegram/opencode-patch-approval');
const { applyOpenCodeCandidatePatch } = require('../../src/telegram/opencode-apply');
const { runOpenCodeAppliedPatchGates } = require('../../src/telegram/opencode-gates');
const { createOpenCodeCommitApproval, defaultCommitApprovalId, normalizeCommitMessage } = require('../../src/telegram/opencode-commit-approval');

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-commit-approval-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-commit-approval'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'scripts', 'gates'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(rootDir, 'scripts', 'gates', 'run-all.sh'), '#!/usr/bin/env bash\necho gates-ok\n');
  fs.chmodSync(path.join(rootDir, 'scripts', 'gates', 'run-all.sh'), 0o755);
  gitCommit(rootDir, 'init');
  return rootDir;
}

function makeAppliedPatchWithGreenGates(rootDir, approvalId = 'APR-COMMIT-APPROVAL-1') {
  const sandboxRoot = `.ralph/tmp/opencode-sandbox/${approvalId}`;
  const patchPath = candidatePatchPath(rootDir, sandboxRoot);
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, PATCH_TEXT);
  gitCommit(rootDir, 'candidate patch');
  const preview = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot });
  const created = createOpenCodePatchPreviewApproval(preview, {
    rootDir,
    approval_id: `APR-PATCH-${approvalId}`,
    allowed_user_ids: [3],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  approveApprovalRecordOnly(created.approval_id, 3, { rootDir });
  const approval = readApproval(rootDir, created.approval_id);
  expect(applyOpenCodeCandidatePatch({ rootDir, approval_id: approval.approval_id, patch_hash: approval.patch_hash }).ok).toBe(true);
  expect(runOpenCodeAppliedPatchGates({ rootDir, approval_id: approval.approval_id, patch_hash: approval.patch_hash }).ok).toBe(true);
  return approval;
}

test('defaultCommitApprovalId and normalizeCommitMessage are deterministic', () => {
  expect(defaultCommitApprovalId(new Date('2026-05-07T12:34:56.789Z'))).toBe('APR-OPENCODE-COMMIT-20260507123456');
  expect(normalizeCommitMessage('  hello\nworld  '.repeat(20)).length).toBeLessThanOrEqual(160);
});

test('parseTelegramCommand parses /opencode-commit-approval', () => {
  const parsed = parseTelegramCommand('/opencode-commit-approval APR-1 sha256:abc add generated test');
  expect(parsed.type).toBe('opencode_commit_approval');
  expect(parsed.args).toEqual(['APR-1', 'sha256:abc', 'add', 'generated', 'test']);
});

test('createOpenCodeCommitApproval creates pending commit approval without committing', () => {
  const rootDir = makeGitRepo();
  const sourceApproval = makeAppliedPatchWithGreenGates(rootDir);
  const result = createOpenCodeCommitApproval({
    rootDir,
    approval_id: sourceApproval.approval_id,
    patch_hash: sourceApproval.patch_hash,
    commit_message: 'add generated OpenCode test',
    allowed_user_ids: [3],
    now: new Date('2026-05-07T12:34:56.789Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_commit_approval',
    reason: null,
    approval_id: 'APR-OPENCODE-COMMIT-20260507123456',
    source_approval_id: sourceApproval.approval_id,
    patch_hash: sourceApproval.patch_hash,
    commit_message: 'add generated OpenCode test',
    repository_files_modified: ['tests/opencode-generated.spec.js'],
    commit_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: ['tests/opencode-generated.spec.js'],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'approve_or_deny_commit_before_git_commit'
  });
  expect(result.approval.status).toBe(APPROVAL_STATUSES.PENDING);
});

test('createOpenCodeCommitApproval blocks invalid inputs before commit approval', () => {
  const rootDir = makeGitRepo();
  const sourceApproval = makeAppliedPatchWithGreenGates(rootDir);

  expect(createOpenCodeCommitApproval({ rootDir, patch_hash: sourceApproval.patch_hash, commit_message: 'x' }).reason).toBe('source_approval_id_required');
  expect(createOpenCodeCommitApproval({ rootDir, approval_id: sourceApproval.approval_id, patch_hash: sourceApproval.patch_hash, commit_message: '' }).reason).toBe('commit_message_required');
  expect(createOpenCodeCommitApproval({ rootDir, approval_id: 'missing', patch_hash: sourceApproval.patch_hash, commit_message: 'x' }).reason).toBe('source_approval_not_found');
  expect(createOpenCodeCommitApproval({ rootDir, approval_id: sourceApproval.approval_id, patch_hash: 'sha256:nope', commit_message: 'x' }).reason).toBe('patch_hash_mismatch');
});

test('/opencode-commit-approval handler returns pending approval summary', () => {
  const rootDir = makeGitRepo();
  const sourceApproval = makeAppliedPatchWithGreenGates(rootDir);
  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-commit-approval ${sourceApproval.approval_id} ${sourceApproval.patch_hash} add generated test`), {
    rootDir,
    user_id: 3,
    now: new Date('2026-05-07T12:34:56.789Z'),
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.commit_allowed).toBe(false);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.approval_id).toBe('APR-OPENCODE-COMMIT-20260507123456');
  expect(result.summary.repository_files_modified).toEqual(['tests/opencode-generated.spec.js']);
  expect(result.text).toContain('OpenCode commit approval requested. Commit remains disabled until approval.');
});
