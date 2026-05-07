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
const { opencodeGatesPreflight, runOpenCodeAppliedPatchGates } = require('../../src/telegram/opencode-gates');

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gates-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-gates'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'scripts', 'gates'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(rootDir, 'scripts', 'gates', 'run-all.sh'), '#!/usr/bin/env bash\necho gates-ok\n');
  fs.chmodSync(path.join(rootDir, 'scripts', 'gates', 'run-all.sh'), 0o755);
  gitCommit(rootDir, 'init');
  return rootDir;
}

function makeAppliedPatch(rootDir, approvalId = 'APR-GATES-1') {
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
  const applied = applyOpenCodeCandidatePatch({ rootDir, approval_id: approval.approval_id, patch_hash: approval.patch_hash });
  expect(applied.ok).toBe(true);
  return { approval, applied };
}

test('parseTelegramCommand parses /opencode-gates', () => {
  const parsed = parseTelegramCommand('/opencode-gates APR-1 sha256:abc');
  expect(parsed.type).toBe('opencode_gates');
  expect(parsed.args).toEqual(['APR-1', 'sha256:abc']);
});

test('opencodeGatesPreflight passes only after approved patch is applied', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeAppliedPatch(rootDir);
  const result = opencodeGatesPreflight({ rootDir, approval_id: approval.approval_id, patch_hash: approval.patch_hash });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_gates_preflight',
    reason: null,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash,
    candidate_patch_path: approval.candidate_patch_path,
    repository_files_modified: ['tests/opencode-generated.spec.js'],
    command: 'scripts/gates/run-all.sh',
    execution_connected: false,
    commands_executed: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('runOpenCodeAppliedPatchGates runs local gates without commit push deploy or migration', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeAppliedPatch(rootDir);
  const times = [new Date('2026-05-07T00:00:00.000Z'), new Date('2026-05-07T00:00:00.090Z')];
  const result = runOpenCodeAppliedPatchGates({
    rootDir,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash,
    now: () => times.shift() || new Date('2026-05-07T00:00:00.090Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_gates',
    reason: null,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash,
    command: 'scripts/gates/run-all.sh',
    exit_code: 0,
    started_at: '2026-05-07T00:00:00.000Z',
    finished_at: '2026-05-07T00:00:00.090Z',
    duration_ms: 90,
    execution_connected: true,
    gates_started: true,
    commands_executed: ['scripts/gates/run-all.sh'],
    repository_files_modified: ['tests/opencode-generated.spec.js'],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'review_diff_then_commit_with_operator_approval'
  });
  expect(result.stdout_preview).toContain('gates-ok');
});

test('runOpenCodeAppliedPatchGates blocks bad hash before execution', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeAppliedPatch(rootDir);
  const result = runOpenCodeAppliedPatchGates({ rootDir, approval_id: approval.approval_id, patch_hash: 'sha256:nope' });
  expect(result).toMatchObject({
    ok: false,
    stage: 'opencode_gates',
    reason: 'patch_hash_mismatch',
    execution_connected: false,
    gates_started: false,
    commands_executed: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('/opencode-gates handler runs gates and reports bounded summary', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeAppliedPatch(rootDir);
  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-gates ${approval.approval_id} ${approval.patch_hash}`), {
    rootDir,
    user_id: 3,
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(true);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.repository_files_modified).toEqual(['tests/opencode-generated.spec.js']);
  expect(result.summary.commit_created).toBe(false);
  expect(result.summary.push_performed).toBe(false);
  expect(result.text).toContain('OpenCode gates passed. Review diff before commit.');
});
