const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { approveApprovalRecordOnly, readApproval } = require('../../src/ralph/approval-manager');
const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const { candidatePatchPath, previewOpenCodeCandidatePatch } = require('../../src/telegram/opencode-patch-preview');
const { createOpenCodePatchPreviewApproval } = require('../../src/telegram/opencode-patch-approval');
const { applyOpenCodeCandidatePatch, gitChangedFiles } = require('../../src/telegram/opencode-apply');

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-apply-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-apply'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  gitCommit(rootDir, 'init');
  return rootDir;
}

function makeApprovedPatchApproval(rootDir, approvalId = 'APR-APPLY-1') {
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
  return { approval: readApproval(rootDir, created.approval_id), patchPath };
}

test('parseTelegramCommand parses /opencode-apply', () => {
  const parsed = parseTelegramCommand('/opencode-apply APR-1 sha256:abc');
  expect(parsed.type).toBe('opencode_apply');
  expect(parsed.args).toEqual(['APR-1', 'sha256:abc']);
});

test('applyOpenCodeCandidatePatch applies approved candidate patch without commit push deploy or migration', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeApprovedPatchApproval(rootDir);
  const times = [new Date('2026-05-07T00:00:00.000Z'), new Date('2026-05-07T00:00:00.050Z')];

  const result = applyOpenCodeCandidatePatch({
    rootDir,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash,
    now: () => times.shift() || new Date('2026-05-07T00:00:00.050Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_apply',
    reason: null,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash,
    candidate_patch_path: approval.candidate_patch_path,
    command: 'git apply',
    exit_code: 0,
    started_at: '2026-05-07T00:00:00.000Z',
    finished_at: '2026-05-07T00:00:00.050Z',
    duration_ms: 50,
    apply_allowed: true,
    execution_connected: true,
    commands_executed: ['git apply --whitespace=nowarn <candidate_patch_path>'],
    files_modified: ['tests/opencode-generated.spec.js'],
    repository_files_modified: ['tests/opencode-generated.spec.js'],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'run_local_gates_then_review_diff'
  });
  expect(fs.readFileSync(path.join(rootDir, 'tests/opencode-generated.spec.js'), 'utf8')).toContain('module.exports = value');
});

test('applyOpenCodeCandidatePatch blocks when preflight fails', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeApprovedPatchApproval(rootDir);
  const result = applyOpenCodeCandidatePatch({ rootDir, approval_id: approval.approval_id, patch_hash: 'sha256:nope' });
  expect(result).toMatchObject({
    ok: false,
    stage: 'opencode_apply',
    reason: 'patch_hash_mismatch',
    apply_allowed: false,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: []
  });
});

test('gitChangedFiles returns compact repository file list', () => {
  const rootDir = makeGitRepo();
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# changed\n');
  expect(gitChangedFiles(rootDir)).toEqual(['README.md']);
});

test('/opencode-apply handler applies patch and reports bounded summary', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeApprovedPatchApproval(rootDir, 'APR-APPLY-HANDLER');
  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-apply ${approval.approval_id} ${approval.patch_hash}`), {
    rootDir,
    user_id: 3,
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(true);
  expect(result.apply_allowed).toBe(true);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.repository_files_modified).toEqual(['tests/opencode-generated.spec.js']);
  expect(result.summary.commit_created).toBe(false);
  expect(result.summary.push_performed).toBe(false);
  expect(result.text).toContain('OpenCode apply completed. Review diff and run gates.');
});
