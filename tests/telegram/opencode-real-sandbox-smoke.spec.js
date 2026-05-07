const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { OPENCODE_SANDBOX_ENV } = require('../../src/telegram/opencode-sandbox-preflight');
const {
  MAX_PREVIEW_CHARS,
  oneLine,
  commandPreview,
  commandIsSafe,
  runRealOpenCodeSandboxSmoke
} = require('../../src/telegram/opencode-real-sandbox-smoke');

function gitCommit(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: rootDir, stdio: 'ignore' });
}

function makeGitRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-real-smoke-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-real-smoke'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp', 'opencode-sandbox'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  gitCommit(rootDir, 'init');
  return rootDir;
}

function passingPreflight(approvalId = 'APR-OPENCODE-REAL-SMOKE-1') {
  return {
    ok: true,
    start_allowed: true,
    approval_id: approvalId,
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    requested_paths: ['src/foo.js'],
    execution_connected: false,
    opencode_execution_started: false,
    commands_executed: [],
    files_modified: []
  };
}

function installSandboxTestDouble(rootDir, preflight) {
  const fixtureSource = path.resolve(process.cwd(), 'tests/fixtures/opencode-version-double.js');
  const fixtureDest = path.join(rootDir, preflight.sandbox_root, 'tests', 'fixtures', 'opencode-version-double.js');
  fs.mkdirSync(path.dirname(fixtureDest), { recursive: true });
  fs.copyFileSync(fixtureSource, fixtureDest);
  return fixtureDest;
}

test('real OpenCode smoke output previews are bounded and redacted', () => {
  const raw = `token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi ${'x'.repeat(400)}`;
  const preview = oneLine(raw);
  expect(preview.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
  expect(preview).toContain('<redacted>');
  expect(preview).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi');
});

test('real OpenCode smoke command allowlist is strict', () => {
  expect(commandIsSafe('opencode', ['--version'])).toBe(true);
  expect(commandIsSafe(process.execPath, ['tests/fixtures/opencode-version-double.js'])).toBe(true);
  expect(commandIsSafe('node', ['tests/fixtures/opencode-version-double.js'])).toBe(true);

  expect(commandIsSafe('opencode', ['run'])).toBe(false);
  expect(commandIsSafe('opencode;rm -rf .', ['--version'])).toBe(false);
  expect(commandIsSafe('node', ['../opencode-version-double.js'])).toBe(false);
  expect(commandIsSafe('bash', ['-lc', 'echo hi'])).toBe(false);
  expect(commandPreview('opencode', ['--version'])).toBe('opencode --version');
});

test('real OpenCode sandbox smoke refuses failed preflight and missing env gate', () => {
  const rootDir = makeGitRepo();
  const preflight = passingPreflight();

  const failed = runRealOpenCodeSandboxSmoke({ ...preflight, ok: false, start_allowed: false, reason: 'preflight_failed' }, {
    rootDir,
    command: process.execPath,
    args: ['tests/fixtures/opencode-version-double.js'],
    env: { [OPENCODE_SANDBOX_ENV]: 'true', PATH: process.env.PATH, HOME: process.env.HOME }
  });
  expect(failed.ok).toBe(false);
  expect(failed.reason).toBe('preflight_failed');
  expect(failed.real_opencode_process_started).toBe(false);
  expect(failed.commands_executed).toEqual([]);

  const noEnv = runRealOpenCodeSandboxSmoke(preflight, {
    rootDir,
    command: process.execPath,
    args: ['tests/fixtures/opencode-version-double.js'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME }
  });
  expect(noEnv.ok).toBe(false);
  expect(noEnv.reason).toBe('opencode_sandbox_env_not_enabled');
  expect(noEnv.real_opencode_process_started).toBe(false);
  expect(noEnv.commands_executed).toEqual([]);
});

test('real OpenCode sandbox smoke runs test double only in sandbox cwd and keeps repo clean', () => {
  const rootDir = makeGitRepo();
  const preflight = passingPreflight();
  installSandboxTestDouble(rootDir, preflight);

  const times = [new Date('2026-05-07T00:00:00.000Z'), new Date('2026-05-07T00:00:00.125Z')];
  const result = runRealOpenCodeSandboxSmoke(preflight, {
    rootDir,
    command: process.execPath,
    args: ['tests/fixtures/opencode-version-double.js'],
    env: { [OPENCODE_SANDBOX_ENV]: 'true', PATH: process.env.PATH, HOME: process.env.HOME },
    timeout_ms: 3000,
    now: () => times.shift() || new Date('2026-05-07T00:00:00.125Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_real_sandbox_smoke',
    reason: null,
    runner: 'real_opencode_sandbox_smoke',
    approval_id: preflight.approval_id,
    sandbox_root: preflight.sandbox_root,
    cwd: preflight.sandbox_root,
    command_preview: `${process.execPath} tests/fixtures/opencode-version-double.js`,
    exit_code: 0,
    started_at: '2026-05-07T00:00:00.000Z',
    finished_at: '2026-05-07T00:00:00.125Z',
    duration_ms: 125,
    timeout_ms: 3000,
    stdout_preview: 'opencode-test-double 0.0.0',
    stderr_preview: '',
    execution_connected: true,
    opencode_execution_started: true,
    real_opencode_process_started: true,
    commands_executed: [`${process.execPath} tests/fixtures/opencode-version-double.js`],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    post_git_status_clean: true,
    next_action: 'review_real_opencode_smoke_then_consider_phase13_patch_preview'
  });
  expect(result.stdout_length).toBeGreaterThan(0);
  expect(result.stderr_length).toBe(0);
});

test('real OpenCode sandbox smoke rejects unsafe command without starting process', () => {
  const rootDir = makeGitRepo();
  const preflight = passingPreflight();
  const result = runRealOpenCodeSandboxSmoke(preflight, {
    rootDir,
    command: 'bash',
    args: ['-lc', 'echo unsafe'],
    env: { [OPENCODE_SANDBOX_ENV]: 'true', PATH: process.env.PATH, HOME: process.env.HOME }
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('opencode_command_not_allowed');
  expect(result.execution_connected).toBe(false);
  expect(result.real_opencode_process_started).toBe(false);
  expect(result.commands_executed).toEqual([]);
});
