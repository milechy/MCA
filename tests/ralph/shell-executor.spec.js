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

test('shell executor blocks dry-run-only allowlist entries by default', () => {
  const rootDir = makeTempRoot();
  const result = executeShellCommand({
    command: 'scripts/gates/run-all.sh',
    args: [],
    cwd: '.'
  }, { rootDir });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('allowlist_entry_is_dry_run_only');
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
