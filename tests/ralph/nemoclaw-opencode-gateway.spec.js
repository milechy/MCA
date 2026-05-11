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
  buildOpenClawCandidatePatchPrompt,
  buildOpenShellAgentArgs,
  candidatePatchCommandAvailable,
  runtimeInstalled,
  runNemoClawOpenCodeCandidatePatch,
  UNSUPPORTED_CANDIDATE_PATCH_REASON
} = require('../../src/ralph/nemoclaw-opencode-gateway');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-nemoclaw-gateway-'));
}

function spawnRuntimeInstalledThenRun({ patch = 'diff --git a/tests/generated.js b/tests/generated.js\n', stdout = '{"ok":true}', stderr = '', status = 0 } = {}) {
  return (command, args) => {
    if (command === 'nemoclaw' && args[0] === '--version') return { status: 0, stdout: 'nemoclaw 0.1.0', stderr: '' };
    if (command === 'openshell' && args[0] === 'sandbox' && args[1] === 'exec' && args.includes('--help')) return { status: 0, stdout: 'Execute a command in a running sandbox', stderr: '' };
    if (command === 'openshell' && args.includes('openclaw') && args.includes('agent')) return { status, stdout, stderr };
    if (command === 'openshell' && args.includes('cat') && args.includes('candidate.patch')) return { status: 0, stdout: patch, stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected ${command} ${args.join(' ')}` };
  };
}

function spawnRuntimeInstalledUnsupportedCommand() {
  return (command, args) => {
    if (command === 'nemoclaw' && args[0] === '--version') return { status: 0, stdout: 'nemoclaw v0.0.38', stderr: '' };
    if (command === 'openshell' && args[0] === 'sandbox' && args[1] === 'exec' && args.includes('--help')) {
      return { status: 1, stdout: 'Usage: openshell sandbox connect', stderr: 'unknown command: exec' };
    }
    return { status: 1, stdout: '', stderr: 'should not execute unsupported command' };
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

test('candidatePatchCommandAvailable detects installed runtime without OpenShell exec contract', () => {
  const result = candidatePatchCommandAvailable('openshell', { spawn: spawnRuntimeInstalledUnsupportedCommand() });
  expect(result).toMatchObject({ ok: false, reason: UNSUPPORTED_CANDIDATE_PATCH_REASON });
});

test('runNemoClawOpenCodeCandidatePatch fails closed when OpenShell exec is unavailable', () => {
  const rootDir = tmpRoot();
  const result = runNemoClawOpenCodeCandidatePatch({
    rootDir,
    approval_id: 'APR-NEMO-UNSUPPORTED',
    job_id: 'JOB-NEMO-UNSUPPORTED',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-NEMO-UNSUPPORTED',
    requested_paths: ['README.md'],
    task: 'Generate candidate.patch only.',
    spawn: spawnRuntimeInstalledUnsupportedCommand(),
    record_job: false
  });

  expect(result).toMatchObject({
    ok: false,
    reason: UNSUPPORTED_CANDIDATE_PATCH_REASON,
    runtime_installed: true,
    candidate_patch_command_available: false,
    execution_connected: false,
    real_gateway_process_started: false,
    opencode_execution_started: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: 'install_openshell_or_configure_nemoclaw_sandbox'
  });
});

test('OpenShell adapter prompt and args are bounded and candidate.patch-only', () => {
  const prompt = buildOpenClawCandidatePatchPrompt({ task: 'Update README', requested_paths: ['README.md'] });
  expect(prompt).toContain('Create exactly one file named candidate.patch');
  expect(prompt).toContain('Do not apply the patch');
  expect(prompt).toContain('Requested paths: README.md');
  const args = buildOpenShellAgentArgs({ sandbox_name: 'mca-ralph', task: 'Update README', requested_paths: ['README.md'], timeout_ms: 60000 });
  expect(args.slice(0, 10)).toEqual(['sandbox', 'exec', '-n', 'mca-ralph', '--workdir', '/sandbox', '--timeout', '60', '--no-tty']);
  expect(args).toContain('openclaw');
  expect(args).toContain('agent');
  expect(args).toContain('--json');
});

test('runNemoClawOpenCodeCandidatePatch allows successful candidate.patch generation through OpenShell and no repository mutation', () => {
  const rootDir = tmpRoot();
  const result = runNemoClawOpenCodeCandidatePatch({
    rootDir,
    approval_id: 'APR-NEMO-OK',
    job_id: 'JOB-NEMO-OK',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-NEMO-OK',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.',
    spawn: spawnRuntimeInstalledThenRun({ stdout: '{"ok":true}' }),
    record_job: false,
    now: () => new Date('2026-05-09T06:00:00.000Z'),
    env: { PATH: '/bin', HOME: '/tmp', NEMOCLAW_SANDBOX_NAME: 'mca-ralph' }
  });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    runtime_installed: true,
    candidate_patch_command_available: true,
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
  expect(result.commands_executed[0]).toContain('openshell sandbox exec -n mca-ralph');
  expect(fs.existsSync(path.join(rootDir, '.ralph/tmp/opencode-sandbox/APR-NEMO-OK/candidate.patch'))).toBe(true);
});

test('runNemoClawOpenCodeCandidatePatch rejects invalid candidate.patch content', () => {
  const rootDir = tmpRoot();
  const result = runNemoClawOpenCodeCandidatePatch({
    rootDir,
    approval_id: 'APR-NEMO-BAD-PATCH',
    job_id: 'JOB-NEMO-BAD-PATCH',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-NEMO-BAD-PATCH',
    requested_paths: ['README.md'],
    task: 'Generate candidate.patch only.',
    spawn: spawnRuntimeInstalledThenRun({ patch: 'not a diff' }),
    record_job: false
  });

  expect(result).toMatchObject({ ok: false, reason: 'candidate_patch_invalid', files_modified: [] });
  expect(fs.existsSync(path.join(rootDir, '.ralph/tmp/opencode-sandbox/APR-NEMO-BAD-PATCH/candidate.patch'))).toBe(false);
});

test('runNemoClawOpenCodeCandidatePatch redacts bounded stdout and stderr previews', () => {
  const rootDir = tmpRoot();
  const result = runNemoClawOpenCodeCandidatePatch({
    rootDir,
    approval_id: 'APR-NEMO-REDACT',
    job_id: 'JOB-NEMO-REDACT',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-NEMO-REDACT',
    requested_paths: ['tests/generated.js'],
    task: 'Generate candidate.patch only.',
    spawn: spawnRuntimeInstalledThenRun({ stdout: 'candidate patch created', stderr: 'bounded diagnostic output' }),
    record_job: false
  });

  expect(result.stdout_preview.length).toBeLessThanOrEqual(600);
  expect(result.stderr_preview.length).toBeLessThanOrEqual(600);
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

test('buildNemoClawArgs keeps legacy policy args behind NemoClaw candidate patch command', () => {
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

test('redactText returns bounded text', () => {
  const text = redactText('x'.repeat(1000));
  expect(text.length).toBeLessThanOrEqual(600);
});
