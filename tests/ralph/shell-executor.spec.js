const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { executeShellCommand } = require('../../src/ralph/shell-executor');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-executor-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), '', 'utf8');
  return rootDir;
}

test('shell executor blocks allowlisted command unless real execution is explicitly enabled', () => {
  const rootDir = makeTempRoot();
  const result = executeShellCommand({
    command: 'scripts/gates/run-all.sh',
    args: [],
    cwd: '.'
  }, { rootDir });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('real_shell_execution_not_enabled');
  expect(result.commands_executed).toEqual([]);
  expect(result.files_modified).toEqual([]);
  expect(result.log.event).toBe('shell_execution_blocked');
});

test('shell executor blocks non-allowlisted command even when real execution is requested', () => {
  const rootDir = makeTempRoot();
  const result = executeShellCommand({
    command: 'npm',
    args: ['test'],
    cwd: '.'
  }, { rootDir, allow_real_execution: true });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('command_not_allowlisted');
  expect(result.commands_executed).toEqual([]);
  expect(result.files_modified).toEqual([]);
  expect(result.log.event).toBe('shell_execution_blocked');
});

test('shell executor can run a test-only allowlisted read-only command', () => {
  const rootDir = makeTempRoot();
  const result = executeShellCommand({
    command: 'node',
    args: ['--version'],
    cwd: '.'
  }, {
    rootDir,
    allow_real_execution: true,
    timeout_ms: 10_000,
    allowlist: [
      {
        id: 'node-version-test-only',
        command: 'node',
        allowed_args: ['--version'],
        allowed_cwd: '.',
        phase: '3.7e-test-only',
        dry_run_only: false
      }
    ]
  });

  expect(result.ok).toBe(true);
  expect(result.executor).toBe('shell');
  expect(result.command).toBe('node');
  expect(result.args).toEqual(['--version']);
  expect(result.exit_code).toBe(0);
  expect(result.stdout.trim()).toMatch(/^v\d+\.\d+\.\d+/);
  expect(result.commands_executed).toEqual(['node']);
  expect(result.files_modified).toEqual([]);
  expect(result.log.event).toBe('shell_execution_completed');
});
