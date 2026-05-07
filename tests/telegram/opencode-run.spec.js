const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { requestApproval, approveRecordOnly } = require('../../src/ralph/approval-manager');
const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const { OPENCODE_SANDBOX_ENV } = require('../../src/telegram/opencode-sandbox-preflight');
const { opencodeSandboxRunnerPreflight } = require('../../src/telegram/opencode-sandbox-preflight');
const { runOpenCodeCandidatePatch, commandIsAllowed, normalizeTask } = require('../../src/telegram/opencode-run');

function gitCommit(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: rootDir, stdio: 'ignore' });
}

function makeGitRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-run-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-run'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-log'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  gitCommit(rootDir, 'init');
  return rootDir;
}

function makeApprovedSandboxPreflight(rootDir, approvalId = 'APR-OPENCODE-RUN-1') {
  const plan = {
    story_id: `STORY-${approvalId}`,
    objective: 'OpenCode sandbox run candidate patch',
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    requested_paths: ['tests/opencode-generated.spec.js']
  };
  requestApproval(plan, { score: 0, category: 'low', label: 'RISK_0_LOW', requires_approval: true }, {
    rootDir,
    approval_id: approvalId,
    approval_type: 'plan',
    requested_action: 'opencode_sandbox_run',
    allowed_user_ids: [3],
    expires_at: '2026-05-07T01:00:00.000Z'
  });
  approveRecordOnly(approvalId, 3, { rootDir });
  gitCommit(rootDir, `approval ${approvalId}`);

  return opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: approvalId,
    sandbox_root: plan.sandbox_root,
    requested_paths: plan.requested_paths,
    pre_secret_scan_ok: true,
    env: { [OPENCODE_SANDBOX_ENV]: 'true' },
    now: new Date('2026-05-07T00:00:00.000Z')
  });
}

test('parseTelegramCommand parses /opencode-run', () => {
  const parsed = parseTelegramCommand('/opencode-run APR-1 .ralph/tmp/opencode-sandbox/APR-1 add a test');
  expect(parsed.type).toBe('opencode_run');
  expect(parsed.args).toEqual(['APR-1', '.ralph/tmp/opencode-sandbox/APR-1', 'add', 'a', 'test']);
});

test('opencode run task and command guards are strict', () => {
  expect(normalizeTask(`hello\nworld ${'x'.repeat(1200)}`).length).toBeLessThanOrEqual(1000);
  expect(commandIsAllowed('opencode', ['run', '--diff-only', '--task', 'add test'])).toBe(true);
  expect(commandIsAllowed(process.execPath, ['tests/fixtures/opencode-candidate-patch-double.js'])).toBe(true);
  expect(commandIsAllowed('opencode', ['run', '--task', 'add test'])).toBe(false);
  expect(commandIsAllowed('bash', ['-lc', 'echo nope'])).toBe(false);
  expect(commandIsAllowed('node', ['../opencode-candidate-patch-double.js'])).toBe(false);
});

test('runOpenCodeCandidatePatch executes sandbox candidate patch generation only', () => {
  const rootDir = makeGitRepo();
  const preflight = makeApprovedSandboxPreflight(rootDir);
  const fixtureSource = path.resolve(process.cwd(), 'tests/fixtures/opencode-candidate-patch-double.js');
  const fixtureDest = path.join(rootDir, preflight.sandbox_root, 'tests', 'fixtures', 'opencode-candidate-patch-double.js');
  fs.mkdirSync(path.dirname(fixtureDest), { recursive: true });
  fs.copyFileSync(fixtureSource, fixtureDest);
  gitCommit(rootDir, 'add sandbox candidate patch double');

  const times = [new Date('2026-05-07T00:00:00.000Z'), new Date('2026-05-07T00:00:00.200Z')];
  const result = runOpenCodeCandidatePatch(preflight, {
    rootDir,
    task: 'add generated test',
    command: process.execPath,
    args: ['tests/fixtures/opencode-candidate-patch-double.js'],
    env: { [OPENCODE_SANDBOX_ENV]: 'true', PATH: process.env.PATH, HOME: process.env.HOME },
    now: () => times.shift() || new Date('2026-05-07T00:00:00.200Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_run_candidate_patch',
    reason: null,
    approval_id: preflight.approval_id,
    sandbox_root: preflight.sandbox_root,
    task_preview: 'add generated test',
    cwd: preflight.sandbox_root,
    exit_code: 0,
    started_at: '2026-05-07T00:00:00.000Z',
    finished_at: '2026-05-07T00:00:00.200Z',
    duration_ms: 200,
    stdout_preview: 'candidate.patch written',
    candidate_patch_path: `${preflight.sandbox_root}/candidate.patch`,
    execution_connected: true,
    opencode_execution_started: true,
    real_opencode_process_started: true,
    apply_allowed: false,
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'create_patch_preview_approval_then_apply_preflight'
  });
  expect(result.patch_preview).toMatchObject({ ok: true, apply_allowed: false, requires_approval: true, files_touched: ['tests/opencode-generated.spec.js'] });
  expect(result.files_modified).toEqual([`${preflight.sandbox_root}/candidate.patch`]);
});

test('runOpenCodeCandidatePatch blocks without preflight, env, task, or allowed command', () => {
  const rootDir = makeGitRepo();
  const preflight = makeApprovedSandboxPreflight(rootDir);

  expect(runOpenCodeCandidatePatch(preflight, { rootDir, task: '', env: { [OPENCODE_SANDBOX_ENV]: 'true' } }).reason).toBe('task_required');
  expect(runOpenCodeCandidatePatch({ ...preflight, ok: false, start_allowed: false, reason: 'blocked' }, { rootDir, task: 'x', env: { [OPENCODE_SANDBOX_ENV]: 'true' } }).reason).toBe('blocked');
  expect(runOpenCodeCandidatePatch(preflight, { rootDir, task: 'x', env: {} }).reason).toBe('opencode_sandbox_env_not_enabled');
  expect(runOpenCodeCandidatePatch(preflight, { rootDir, task: 'x', command: 'bash', args: ['-lc', 'echo nope'], env: { [OPENCODE_SANDBOX_ENV]: 'true' } }).reason).toBe('opencode_command_not_allowed');
});

test('/opencode-run handler executes candidate patch generation and never applies patch', () => {
  const rootDir = makeGitRepo();
  const preflight = makeApprovedSandboxPreflight(rootDir, 'APR-OPENCODE-RUN-2');
  const fixtureSource = path.resolve(process.cwd(), 'tests/fixtures/opencode-candidate-patch-double.js');
  const fixtureDest = path.join(rootDir, preflight.sandbox_root, 'tests', 'fixtures', 'opencode-candidate-patch-double.js');
  fs.mkdirSync(path.dirname(fixtureDest), { recursive: true });
  fs.copyFileSync(fixtureSource, fixtureDest);
  gitCommit(rootDir, 'add handler candidate patch double');

  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-run ${preflight.approval_id} ${preflight.sandbox_root} add generated test`), {
    rootDir,
    user_id: 3,
    pre_secret_scan_ok: true,
    requested_paths: ['tests/opencode-generated.spec.js'],
    env: { [OPENCODE_SANDBOX_ENV]: 'true', PATH: process.env.PATH, HOME: process.env.HOME },
    opencode_command: process.execPath,
    opencode_args: ['tests/fixtures/opencode-candidate-patch-double.js'],
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(true);
  expect(result.apply_allowed).toBe(false);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.patch_preview.ok).toBe(true);
  expect(result.summary.apply_allowed).toBe(false);
  expect(result.summary.repository_files_modified).toEqual([]);
  expect(result.text).toContain('OpenCode run completed. candidate.patch is ready; apply remains disabled.');
});
