const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dryRunShellCommand } = require('../../src/ralph/shell-dry-run');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-dry-run-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), '', 'utf8');
  return rootDir;
}

test('dry-run shell command validates allowlisted command without executing it', () => {
  const rootDir = makeTempRoot();
  const result = dryRunShellCommand({
    command: 'scripts/gates/run-all.sh',
    args: [],
    cwd: '.'
  }, { rootDir });

  expect(result.ok).toBe(true);
  expect(result.executor).toBe('shell-dry-run');
  expect(result.commands_executed).toEqual([]);
  expect(result.files_modified).toEqual([]);
  expect(result.dry_run_only).toBe(true);
  expect(result.log.event).toBe('shell_command_dry_run_validated');
});

test('dry-run shell command rejects non-allowlisted command and logs rejection', () => {
  const rootDir = makeTempRoot();
  const result = dryRunShellCommand({
    command: 'npm',
    args: ['test'],
    cwd: '.'
  }, { rootDir });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('command_not_allowlisted');
  expect(result.log.event).toBe('shell_command_rejected');
});
