const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  NEMOCLAW_ACTIONS,
  buildNemoClawPolicy,
  argsContainForbiddenEscalation,
  outputIsCandidatePatchOnly,
  redactText
} = require('../../src/ralph/nemoclaw-policy');
const {
  buildNemoClawArgs,
  runtimeInstalled,
  runNemoClawOpenCodeCandidatePatch
} = require('../../src/ralph/nemoclaw-opencode-gateway');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-nemoclaw-gateway-'));
}

function fakeGitHubToken() {
  return ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz'].join('');
}

function spawnRuntimeInstalledThenRun({ writePatch = true, stdout = '', stderr = '', status = 0 } = {}) {
  return (command, args, options = {}) => {
    if (args[0] === '--version') return { status: 0, stdout: 'nemoclaw 0.1.0', stderr: '' };
    if (writePatch) fs.writeFileSync(path.join(options.cwd, 'candidate.patch'), 'diff --git a/tests/generated.js b/tests/generated.js\n');
    return { status, stdout, stderr };
  };
}

test('buildNemoClawPolicy allows candidate.patch generation only with safe bounded metadata', () => {
  const policy = buildNemoClawPolicy({
    action: NEMOCLAW_ACTIONS.RUN_CANDIDATE_PATCH,
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-1',
    requested_paths: ['src/ralph/nemoclaw-opencode-gateway.js'],
    task: 'Create candidate.patch only.'
  });

  expect(policy).toMatchObject({
    ok: true,
    stage: 'nemoclaw_policy',
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-1/candidate.patch',
    allowed_outputs: ['.ralph/tmp/opencode-sandbox/APR-1/candidate.patch'],
    execution_allowed: true,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false,
    raw_log_allowed: false,
    secret_display_allowed: false,
    secret_persistence_allowed: false,
    bounded_metadata_only: true
  });
});

test('buildNemoClawPolicy denies forbidden runtime commands and unsafe sandbox paths', () => {
  expect(buildNemoClawPolicy({
    action: NEMOCLAW_ACTIONS.RUN_CANDIDATE_PATCH,
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-1',
    requested_paths: ['src/ok.js'],
    task: 'Generate candidate patch',
    args: ['opencode', 'run-candidate-patch', '--push']
  })).toMatchObject({ ok: false, reason: 'nemoclaw_runtime_args_not_allowed' });

  expect(buildNemoClawPolicy({
    action: NEMOCLAW_ACTIONS.RUN_CANDIDATE_PATCH,
    sandbox_root: '../outside',
    requested_paths: ['src/ok.js'],
    task: 'Generate candidate patch'
  })).toMatchObject({ ok: false, reason: 'sandbox_root_not_allowed' });

  expect(argsContainForbiddenEscalation(['opencode', 'run', '--deploy'])).toBe(true);
  expect(argsContainForbiddenEscalation(['opencode', 'run', 'safe; rm -rf .'])).toBe(true);
});

test('runNemoClawOpenCodeCandidatePatch reports runtime-not-installed without starting execution', () => {
  const rootDir = tmpRoot();
  const result = runNemoClawOpenCodeCandidatePatch({
    rootDir,
    approval_id: 'APR-NEMO-NO-RUNTIME',
    job_id: 'JOB-NEMO-NO-RUNTIME',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-NEMO-NO-RUNTIME',
    requested_paths: ['src/ralph/nemoclaw-opencode-gateway.js'],
    task: 'Generate candidate.patch only.',
    spawn: () => ({ error: { code: 'ENOENT', message: 'not found' }, status: null }),
    record_job: false
  });

  expect(result).toMatchObject({
    ok: false,
    reason: 'nemoclaw_runtime_not_installed',
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    runtime_installed: false,
    execution_connected: false,
    real_gateway_process_started: false,
    opencode_execution_started: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  });
});

test('runNemoClawOpenCodeCandidatePatch allows successful candidate.patch generation and no repository mutation', () => {
  const rootDir = tmpRoot();
  const result = runNemoClawOpenCodeCandidatePatch({
    rootDir,
    approval_id: 'APR-NEMO-OK',
    job_id: 'JOB-NEMO-OK',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-NEMO-OK',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.',
    spawn: spawnRuntimeInstalledThenRun({ stdout: 'created candidate patch' }),
    record_job: false,
    now: () => new Date('2026-05-09T06:00:00.000Z')
  });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    runtime_installed: true,
    execution_connected: true,
    real_gateway_process_started: true,
    opencode_execution_started: true,
    candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-NEMO-OK/candidate.patch',
    files_modified: ['.ralph/tmp/opencode-sandbox/APR-NEMO-OK/candidate.patch'],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: 'preview_candidate_patch_before_apply'
  });
  expect(fs.existsSync(path.join(rootDir, '.ralph/tmp/opencode-sandbox/APR-NEMO-OK/candidate.patch'))).toBe(true);
});

test('runNemoClawOpenCodeCandidatePatch redacts secret-shaped stdout and stderr', () => {
  const rootDir = tmpRoot();
  const tokenFixture = fakeGitHubToken();
  const emailFixture = ['dev', 'example.com'].join('@');
  const result = runNemoClawOpenCodeCandidatePatch({
    rootDir,
    approval_id: 'APR-NEMO-SECRET',
    job_id: 'JOB-NEMO-SECRET',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-NEMO-SECRET',
    requested_paths: ['tests/generated.js'],
    task: `Generate candidate.patch only for ${emailFixture}`,
    spawn: spawnRuntimeInstalledThenRun({ stdout: `token=${tokenFixture}`, stderr: `password: hunter2 ${emailFixture}` }),
    record_job: false
  });

  expect(JSON.stringify(result)).not.toContain(tokenFixture);
  expect(JSON.stringify(result)).not.toContain(emailFixture);
  expect(JSON.stringify(result)).not.toContain('hunter2');
});

test('runNemoClawOpenCodeCandidatePatch fails policy before runtime for forbidden args', () => {
  const rootDir = tmpRoot();
  const calls = [];
  const result = runNemoClawOpenCodeCandidatePatch({
    rootDir,
    approval_id: 'APR-NEMO-POLICY',
    job_id: 'JOB-NEMO-POLICY',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-NEMO-POLICY',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.',
    args: ['opencode', 'run-candidate-patch', '--merge'],
    spawn: (...args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    record_job: false
  });

  expect(result).toMatchObject({ ok: false, reason: 'nemoclaw_runtime_args_not_allowed', execution_connected: false });
  expect(calls).toHaveLength(0);
});

test('candidate.patch only helper rejects non-candidate outputs', () => {
  expect(outputIsCandidatePatchOnly('.ralph/tmp/opencode-sandbox/APR-1/candidate.patch', '.ralph/tmp/opencode-sandbox/APR-1')).toBe(true);
  expect(outputIsCandidatePatchOnly('.ralph/tmp/opencode-sandbox/APR-1/other.patch', '.ralph/tmp/opencode-sandbox/APR-1')).toBe(false);
});

test('buildNemoClawArgs keeps OpenCode behind NemoClaw candidate patch command', () => {
  expect(buildNemoClawArgs({ task: 'Do work', candidate_patch_path: 'candidate.patch', requested_paths: ['src/a.js'] })).toEqual([
    'opencode',
    'run-candidate-patch',
    '--candidate-patch',
    'candidate.patch',
    '--requested-paths',
    'src/a.js',
    '--task',
    'Do work'
  ]);
});

test('runtimeInstalled only treats missing binary as not installed', () => {
  expect(runtimeInstalled('nemoclaw', { spawn: () => ({ error: { code: 'ENOENT' } }) })).toBe(false);
  expect(runtimeInstalled('nemoclaw', { spawn: () => ({ status: 2, stderr: 'usage' }) })).toBe(true);
});

test('redactText removes common secret-shaped values', () => {
  const tokenFixture = fakeGitHubToken();
  const emailFixture = ['root', 'example.com'].join('@');
  const text = redactText(`token=${tokenFixture} password: hunter2 ${emailFixture}`);
  expect(text).not.toContain(tokenFixture);
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain(emailFixture);
});
