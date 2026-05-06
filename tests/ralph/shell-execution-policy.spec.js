const { test, expect } = require('@playwright/test');
const { evaluateShellExecutionPolicy } = require('../../src/ralph/shell-execution-policy');

function commandPreflight(overrides = {}) {
  return {
    ok: true,
    request: {
      command: 'scripts/gates/run-all.sh',
      args: [],
      cwd: '.'
    },
    allowlist_entry: {
      id: 'gates-run-all',
      command: 'scripts/gates/run-all.sh',
      allowed_args: [],
      allowed_cwd: '.',
      phase: '3.7b',
      dry_run_only: true
    },
    command_hash: 'sha256:test',
    ...overrides
  };
}

test('shell execution policy requires successful command preflight', () => {
  const result = evaluateShellExecutionPolicy({ ok: false, reason: 'command_not_allowlisted' });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('command_preflight_required');
});

test('shell execution policy blocks dry-run-only allowlist entry', () => {
  const result = evaluateShellExecutionPolicy(commandPreflight());

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('allowlist_entry_is_dry_run_only');
});

test('shell execution policy requires explicit real execution enablement', () => {
  const result = evaluateShellExecutionPolicy(commandPreflight({
    allowlist_entry: {
      id: 'gates-run-all',
      command: 'scripts/gates/run-all.sh',
      allowed_args: [],
      allowed_cwd: '.',
      phase: '3.7b',
      dry_run_only: false
    }
  }));

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('real_shell_execution_not_enabled');
});

test('shell execution policy allows real execution only when allowlist and explicit flag both allow it', () => {
  const result = evaluateShellExecutionPolicy(commandPreflight({
    allowlist_entry: {
      id: 'gates-run-all',
      command: 'scripts/gates/run-all.sh',
      allowed_args: [],
      allowed_cwd: '.',
      phase: '3.7b',
      dry_run_only: false
    }
  }), { allow_real_execution: true, timeout_ms: 10_000 });

  expect(result.ok).toBe(true);
  expect(result.reason).toBe('real_shell_execution_allowed_by_policy');
  expect(result.command_hash).toBe('sha256:test');
  expect(result.timeout_ms).toBe(10_000);
});
