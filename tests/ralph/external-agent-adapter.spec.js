const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeRuntimeCommand, buildAdapterArgs, argsAreAllowed, runExternalAgentCandidatePatch } = require('../../src/ralph/external-agent-adapter');

function tmpRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-external-agent-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp'), { recursive: true });
  return rootDir;
}

test('runtime command and args are tightly bounded', () => {
  expect(normalizeRuntimeCommand('nemoclaw')).toBe('nemoclaw');
  expect(normalizeRuntimeCommand('nemoclaw', 'nemoclaw')).toBe('nemoclaw');
  expect(normalizeRuntimeCommand('nemoclaw', 'bash')).toBe(null);
  expect(buildAdapterArgs({ task: 'add test', candidate_patch_path: 'candidate.patch', requested_paths: ['tests/x.js'] })).toEqual([
    'run',
    '--candidate-patch',
    'candidate.patch',
    '--requested-paths',
    'tests/x.js',
    '--task',
    'add test'
  ]);
  expect(argsAreAllowed(['run', '--task', 'x'])).toBe(true);
  expect(argsAreAllowed(['run', '--apply'])).toBe(false);
  expect(argsAreAllowed(['run', 'x; rm -rf .'])).toBe(false);
});

test('runExternalAgentCandidatePatch blocks without explicit runtime approval', () => {
  const result = runExternalAgentCandidatePatch({
    rootDir: tmpRoot(),
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw',
    sandbox_root: '.ralph/tmp/gateway/APR-1',
    requested_paths: ['tests/x.js'],
    task: 'add test'
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'runtime_dependency_requires_separate_approval',
    execution_connected: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false
  });
});

test('runExternalAgentCandidatePatch runs approved candidate.patch-only provider in sandbox', () => {
  const rootDir = tmpRoot();
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    fs.writeFileSync(path.join(options.cwd, 'candidate.patch'), 'diff --git a/tests/x.js b/tests/x.js\n--- /dev/null\n+++ b/tests/x.js\n@@ -0,0 +1 @@\n+test\n', 'utf8');
    return { status: 0, stdout: 'candidate patch written', stderr: '' };
  };

  const result = runExternalAgentCandidatePatch({
    rootDir,
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw',
    sandbox_root: '.ralph/tmp/gateway/APR-1',
    requested_paths: ['tests/x.js'],
    task: 'add test',
    explicit_runtime_approval: true,
    spawn,
    now: (() => {
      let t = 0;
      return () => new Date(1700000000000 + (t++ * 25));
    })()
  });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw',
    sandbox_root: '.ralph/tmp/gateway/APR-1',
    candidate_patch_path: '.ralph/tmp/gateway/APR-1/candidate.patch',
    exit_code: 0,
    duration_ms: 25,
    execution_connected: true,
    real_gateway_process_started: true,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    files_modified: ['.ralph/tmp/gateway/APR-1/candidate.patch'],
    repository_files_modified: [],
    next_action: 'preview_candidate_patch_before_apply'
  });
  expect(result.stdout_preview).toBe('candidate patch written');
  expect(calls).toHaveLength(1);
  expect(calls[0].command).toBe('nemoclaw');
  expect(calls[0].cwd).toBe(path.join(rootDir, '.ralph/tmp/gateway/APR-1'));
});

test('runExternalAgentCandidatePatch blocks forbidden runtime command and args', () => {
  const base = {
    rootDir: tmpRoot(),
    gateway_type: 'openclaw',
    gateway_name: 'openclaw',
    sandbox_root: '.ralph/tmp/gateway/APR-1',
    requested_paths: ['tests/x.js'],
    task: 'add test',
    explicit_runtime_approval: true
  };
  expect(runExternalAgentCandidatePatch({ ...base, command: 'bash' }).reason).toBe('gateway_runtime_command_not_allowed');
  expect(runExternalAgentCandidatePatch({ ...base, args: ['run', '--deploy'] }).reason).toBe('gateway_runtime_args_not_allowed');
});
