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
const { applyOpenCodeCandidatePatch } = require('../../src/telegram/opencode-apply');
const { runOpenCodeAppliedPatchGates } = require('../../src/telegram/opencode-gates');
const { createOpenCodeCommitApproval } = require('../../src/telegram/opencode-commit-approval');
const { opencodeCommitPreflight, commitOpenCodeAppliedPatch } = require('../../src/telegram/opencode-commit');

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-commit-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-commit'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'scripts', 'gates'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.gitignore'), '.ralph/\n');
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(rootDir, 'scripts', 'gates', 'run-all.sh'), '#!/usr/bin/env bash\necho gates-ok\n');
  fs.chmodSync(path.join(rootDir, 'scripts', 'gates', 'run-all.sh'), 0o755);
  gitCommit(rootDir, 'init');
  return rootDir;
}

function makeApprovedCommitApproval(rootDir, approvalId = 'APR-COMMIT-1') {
  const sandboxRoot = `.ralph/tmp/opencode-sandbox/${approvalId}`;
  const patchPath = candidatePatchPath(rootDir, sandboxRoot);
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, PATCH_TEXT);
  const preview = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot });
  const created = createOpenCodePatchPreviewApproval(preview, {
    rootDir,
    approval_id: `APR-PATCH-${approvalId}`,
    allowed_user_ids: [3],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  approveApprovalRecordOnly(created.approval_id, 3, { rootDir });
  const patchApproval = readApproval(rootDir, created.approval_id);
  expect(applyOpenCodeCandidatePatch({ rootDir, approval_id: patchApproval.approval_id, patch_hash: patchApproval.patch_hash }).ok).toBe(true);
  expect(runOpenCodeAppliedPatchGates({ rootDir, approval_id: patchApproval.approval_id, patch_hash: patchApproval.patch_hash }).ok).toBe(true);
  const commitApproval = createOpenCodeCommitApproval({
    rootDir,
    approval_id: patchApproval.approval_id,
    patch_hash: patchApproval.patch_hash,
    commit_message: 'add generated OpenCode test',
    allowed_user_ids: [3],
    now: new Date('2026-05-07T12:34:56.789Z')
  });
  expect(commitApproval.ok).toBe(true);
  approveApprovalRecordOnly(commitApproval.approval_id, 3, { rootDir });
  return readApproval(rootDir, commitApproval.approval_id);
}

test('parseTelegramCommand parses /opencode-commit', () => {
  const parsed = parseTelegramCommand('/opencode-commit APR-1');
  expect(parsed.type).toBe('opencode_commit');
  expect(parsed.args).toEqual(['APR-1']);
});

test('opencodeCommitPreflight passes only for approved commit approval', () => {
  const rootDir = makeGitRepo();
  const approval = makeApprovedCommitApproval(rootDir);
  const result = opencodeCommitPreflight({ rootDir, approval_id: approval.approval_id });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_commit_preflight',
    reason: null,
    approval_id: approval.approval_id,
    source_approval_id: approval.source_approval_id,
    patch_hash: approval.patch_hash,
    commit_message: 'add generated OpenCode test',
    repository_files_modified: ['tests/opencode-generated.spec.js'],
    commit_allowed: true,
    execution_connected: false,
    commands_executed: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('commitOpenCodeAppliedPatch creates local commit without push deploy or migration', () => {
  const rootDir = makeGitRepo();
  const approval = makeApprovedCommitApproval(rootDir);
  const times = [new Date('2026-05-07T00:00:00.000Z'), new Date('2026-05-07T00:00:00.080Z')];
  const result = commitOpenCodeAppliedPatch({
    rootDir,
    approval_id: approval.approval_id,
    now: () => times.shift() || new Date('2026-05-07T00:00:00.080Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_commit',
    reason: null,
    approval_id: approval.approval_id,
    source_approval_id: approval.source_approval_id,
    patch_hash: approval.patch_hash,
    commit_message: 'add generated OpenCode test',
    command: 'git commit',
    exit_code: 0,
    started_at: '2026-05-07T00:00:00.000Z',
    finished_at: '2026-05-07T00:00:00.080Z',
    duration_ms: 80,
    execution_connected: true,
    commit_allowed: true,
    commands_executed: ['git add -- <approved_files>', 'git commit -m <approved_commit_message>'],
    files_modified: ['tests/opencode-generated.spec.js'],
    repository_files_modified: ['tests/opencode-generated.spec.js'],
    commit_created: true,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'review_commit_then_push_only_with_operator_approval'
  });
  expect(result.commit_sha).toMatch(/^[a-f0-9]{40}$/);
  expect(execFileSync('git', ['status', '--short'], { cwd: rootDir, encoding: 'utf8' }).trim()).toBe('');
});

test('commitOpenCodeAppliedPatch blocks unapproved commit approval before execution', () => {
  const rootDir = makeGitRepo();
  const approval = makeApprovedCommitApproval(rootDir);
  const pending = { ...approval, approval_id: 'APR-COMMIT-PENDING', status: 'pending' };
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${pending.approval_id}.json`), `${JSON.stringify(pending, null, 2)}\n`);
  const result = commitOpenCodeAppliedPatch({ rootDir, approval_id: pending.approval_id });
  expect(result).toMatchObject({
    ok: false,
    stage: 'opencode_commit',
    reason: 'approval_not_approved',
    execution_connected: false,
    commit_allowed: false,
    commands_executed: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('/opencode-commit handler creates commit and reports bounded summary', () => {
  const rootDir = makeGitRepo();
  const approval = makeApprovedCommitApproval(rootDir);
  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-commit ${approval.approval_id}`), {
    rootDir,
    user_id: 3,
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(true);
  expect(result.commit_allowed).toBe(true);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.commit_created).toBe(true);
  expect(result.summary.push_performed).toBe(false);
  expect(result.summary.deploy_performed).toBe(false);
  expect(result.text).toContain('OpenCode commit completed. Push remains disabled.');
});
