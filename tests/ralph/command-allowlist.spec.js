const { test, expect } = require('@playwright/test');
const { validateCommandRequest, commandHash } = require('../../src/ralph/command-allowlist');

test('allows only scripts/gates/run-all.sh with no args from repo root', () => {
  const result = validateCommandRequest({
    command: 'scripts/gates/run-all.sh',
    args: [],
    cwd: '.'
  });

  expect(result.ok).toBe(true);
  expect(result.allowlist_entry.id).toBe('gates-run-all');
  expect(result.dry_run_only).toBe(true);
  expect(result.command_hash).toMatch(/^sha256:/);
});

test('rejects non-allowlisted command', () => {
  const result = validateCommandRequest({
    command: 'npm',
    args: ['test'],
    cwd: '.'
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('command_not_allowlisted');
});

test('rejects command path traversal and absolute paths', () => {
  expect(validateCommandRequest({ command: '../scripts/gates/run-all.sh', args: [], cwd: '.' }).reason).toBe('command_path_not_allowed');
  expect(validateCommandRequest({ command: '/bin/sh', args: [], cwd: '.' }).reason).toBe('command_path_not_allowed');
});

test('rejects unexpected args and cwd', () => {
  expect(validateCommandRequest({ command: 'scripts/gates/run-all.sh', args: ['--danger'], cwd: '.' }).reason).toBe('command_args_not_allowed');
  expect(validateCommandRequest({ command: 'scripts/gates/run-all.sh', args: [], cwd: 'scripts' }).reason).toBe('command_cwd_not_allowed');
});

test('command hash is deterministic for same request', () => {
  const request = { command: 'scripts/gates/run-all.sh', args: [], cwd: '.' };
  expect(commandHash(request)).toBe(commandHash(request));
});

test('test-only allowlist injection can mark an entry as not dry-run-only without changing production allowlist', () => {
  const injectedAllowlist = [
    {
      id: 'gates-run-all-test',
      command: 'scripts/gates/run-all.sh',
      allowed_args: [],
      allowed_cwd: '.',
      phase: '3.7d-test-only',
      dry_run_only: false
    }
  ];

  const result = validateCommandRequest({
    command: 'scripts/gates/run-all.sh',
    args: [],
    cwd: '.'
  }, { allowlist: injectedAllowlist });

  expect(result.ok).toBe(true);
  expect(result.allowlist_entry.id).toBe('gates-run-all-test');
  expect(result.dry_run_only).toBe(false);

  const productionResult = validateCommandRequest({
    command: 'scripts/gates/run-all.sh',
    args: [],
    cwd: '.'
  });

  expect(productionResult.ok).toBe(true);
  expect(productionResult.allowlist_entry.id).toBe('gates-run-all');
  expect(productionResult.dry_run_only).toBe(true);
});
