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

// ============================================================
// Phase 5 #2: gate-failure observability + transient-flake retry
// ============================================================

const {
  isTransientGateFlake,
  saveFullGateLog,
  KNOWN_TRANSIENT_FLAKE_PATTERNS
} = require('../../src/telegram/opencode-gates');

test('Phase 5 #2: isTransientGateFlake matches the Phase 4 smoke v2 ./** signature', () => {
  // The exact stderr captured in the smoke run (15× repeated, then DEP0190 warning).
  const stderr = "error: Could not access './**' error: Could not access './**' error: Could not access './**' (node:99531) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities…";
  expect(isTransientGateFlake({ stdout: '', stderr })).toBe(true);
});

test('Phase 5 #2: isTransientGateFlake matches in stdout too (not just stderr)', () => {
  // Some shell paths emit the same diagnostic to stdout.
  expect(isTransientGateFlake({ stdout: "warning: error: Could not access './abc/**'", stderr: '' })).toBe(true);
});

test('Phase 5 #2: isTransientGateFlake does NOT match unrelated failures', () => {
  expect(isTransientGateFlake({ stdout: '', stderr: 'test failed: expected true got false' })).toBe(false);
  expect(isTransientGateFlake({ stdout: 'tsc TypeScript error', stderr: '' })).toBe(false);
  expect(isTransientGateFlake({ stdout: '', stderr: 'potential secret detected at .env:1' })).toBe(false);
  expect(isTransientGateFlake({})).toBe(false);
});

test('Phase 5 #2: KNOWN_TRANSIENT_FLAKE_PATTERNS is frozen and non-empty', () => {
  expect(Array.isArray(KNOWN_TRANSIENT_FLAKE_PATTERNS) || typeof KNOWN_TRANSIENT_FLAKE_PATTERNS.length === 'number').toBe(true);
  expect(KNOWN_TRANSIENT_FLAKE_PATTERNS.length).toBeGreaterThan(0);
  expect(Object.isFrozen(KNOWN_TRANSIENT_FLAKE_PATTERNS)).toBe(true);
});

test('Phase 5 #2: saveFullGateLog writes a file with stdout + stderr + metadata', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gates-fulllog-'));
  const now = new Date('2026-05-23T10:00:00.000Z');
  const relPath = saveFullGateLog({
    rootDir,
    approval_id: 'APR-TEST',
    now,
    stdout: '[gate] running ralph-tests\n[ralph-tests] FAIL\n',
    stderr: "error: Could not access './**'\n",
    exit_code: 1,
    attempt: 1
  });
  expect(typeof relPath).toBe('string');
  expect(relPath).toContain('.ralph/logs/gate-failures/APR-TEST-');
  expect(relPath).toContain('attempt1');
  const fullPath = path.join(rootDir, relPath);
  expect(fs.existsSync(fullPath)).toBe(true);
  const content = fs.readFileSync(fullPath, 'utf8');
  expect(content).toContain('approval_id: APR-TEST');
  expect(content).toContain('attempt: 1');
  expect(content).toContain('exit_code: 1');
  expect(content).toContain('# ---- STDOUT ----');
  expect(content).toContain('[ralph-tests] FAIL');
  expect(content).toContain('# ---- STDERR ----');
  expect(content).toContain("Could not access './**'");
});

test('Phase 5 #2: saveFullGateLog returns null for missing rootDir or approval_id (no throw)', () => {
  expect(saveFullGateLog({ rootDir: null, approval_id: 'APR-X', stdout: 'a', stderr: 'b', exit_code: 1 })).toBe(null);
  expect(saveFullGateLog({ rootDir: '/tmp', approval_id: null, stdout: 'a', stderr: 'b', exit_code: 1 })).toBe(null);
  expect(saveFullGateLog({})).toBe(null);
});

test('Phase 5 #2: runOpenCodeAppliedPatchGates persists full_log_path when gate fails', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeAppliedPatch(rootDir, 'APR-GATES-FULLLOG');
  // Make gate fail with the flake signature.
  const failingScript = '#!/usr/bin/env bash\necho "[gate] running ralph-tests"\necho "[ralph-tests] FAIL" >&2\necho "error: Could not access \'./**\'" >&2\nexit 1\n';
  fs.writeFileSync(path.join(rootDir, 'scripts', 'gates', 'run-all.sh'), failingScript);
  fs.chmodSync(path.join(rootDir, 'scripts', 'gates', 'run-all.sh'), 0o755);

  const result = runOpenCodeAppliedPatchGates({
    rootDir,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('opencode_gates_failed');
  expect(typeof result.full_log_path).toBe('string');
  expect(result.full_log_path).toContain('.ralph/logs/gate-failures/');
  const logContent = fs.readFileSync(path.join(rootDir, result.full_log_path), 'utf8');
  expect(logContent).toContain("Could not access './**'");
  expect(logContent).toContain('[ralph-tests] FAIL');
});

test('Phase 5 #2: runOpenCodeAppliedPatchGates with RALPH_GATE_RETRY_ON_FLAKE=1 retries once on transient flake', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeAppliedPatch(rootDir, 'APR-GATES-RETRY');

  // First spawn returns the flake; second spawn succeeds.
  let attempt = 0;
  const fakeSpawn = () => {
    attempt += 1;
    if (attempt === 1) {
      return {
        status: 1,
        stdout: '[gate] running\n',
        stderr: "error: Could not access './**'\nerror: Could not access './**'\n",
        error: null
      };
    }
    return { status: 0, stdout: '[gate] all gates passed', stderr: '', error: null };
  };

  const result = runOpenCodeAppliedPatchGates({
    rootDir,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash,
    spawn: fakeSpawn,
    env: { ...process.env, RALPH_GATE_RETRY_ON_FLAKE: '1' }
  });
  expect(result.ok).toBe(true);
  expect(result.retried_on_flake).toBe(true);
  expect(result.attempts).toBe(2);
  // First attempt's log should still be persisted for post-mortem.
  expect(typeof result.first_attempt_log_path).toBe('string');
  expect(result.first_attempt_log_path).toContain('.ralph/logs/gate-failures/');
});

test('Phase 5 #2: runOpenCodeAppliedPatchGates does NOT retry without the env flag', () => {
  const rootDir = makeGitRepo();
  const { approval } = makeAppliedPatch(rootDir, 'APR-GATES-NORETRY');

  let attempt = 0;
  const fakeSpawn = () => {
    attempt += 1;
    return {
      status: 1,
      stdout: '',
      stderr: "error: Could not access './**'\n",
      error: null
    };
  };

  const result = runOpenCodeAppliedPatchGates({
    rootDir,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash,
    spawn: fakeSpawn,
    env: { ...process.env, RALPH_GATE_RETRY_ON_FLAKE: '' }
  });
  expect(result.ok).toBe(false);
  expect(result.retried_on_flake).toBe(false);
  expect(result.attempts).toBe(1);
  expect(attempt).toBe(1);
});

test('Phase 5 #2: runOpenCodeAppliedPatchGates does NOT retry when failed_gate is parseable (genuine failure)', () => {
  // Genuine, named failures (FAILED_GATE=ralph-tests in stdout) must NEVER
  // trigger flake-retry, even if env flag is on and stderr matches the
  // transient regex — those are real failures and must bubble up.
  const rootDir = makeGitRepo();
  const { approval } = makeAppliedPatch(rootDir, 'APR-GATES-NAMED-FAIL');

  let attempt = 0;
  const fakeSpawn = () => {
    attempt += 1;
    return {
      status: 1,
      stdout: "[gate] FAILED_GATE=ralph-tests\nerror: Could not access './**'",
      stderr: "error: Could not access './**'",
      error: null
    };
  };

  const result = runOpenCodeAppliedPatchGates({
    rootDir,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash,
    spawn: fakeSpawn,
    env: { ...process.env, RALPH_GATE_RETRY_ON_FLAKE: '1' }
  });
  expect(result.ok).toBe(false);
  expect(result.failed_gate).toBe('ralph-tests');
  expect(result.retried_on_flake).toBe(false);
  expect(result.attempts).toBe(1);
  expect(attempt).toBe(1);
});

test('Phase 5 #2: runOpenCodeAppliedPatchGates does NOT retry on non-flake failures even with env flag', () => {
  // Genuine failure (no flake signature) + env flag on → still no retry.
  const rootDir = makeGitRepo();
  const { approval } = makeAppliedPatch(rootDir, 'APR-GATES-REAL-FAIL');

  let attempt = 0;
  const fakeSpawn = () => {
    attempt += 1;
    return {
      status: 1,
      stdout: '',
      stderr: 'Test failed: expected 1 got 2',
      error: null
    };
  };

  const result = runOpenCodeAppliedPatchGates({
    rootDir,
    approval_id: approval.approval_id,
    patch_hash: approval.patch_hash,
    spawn: fakeSpawn,
    env: { ...process.env, RALPH_GATE_RETRY_ON_FLAKE: '1' }
  });
  expect(result.ok).toBe(false);
  expect(result.retried_on_flake).toBe(false);
  expect(result.attempts).toBe(1);
  expect(attempt).toBe(1);
});
