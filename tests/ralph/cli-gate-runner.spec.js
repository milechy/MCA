const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleGateRunnerCommand } = require('../../src/ralph/cli');

function tmpRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-cli-gate-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  return rootDir;
}

function captureConsole(fn) {
  const original = console.log;
  const lines = [];
  console.log = (value) => lines.push(String(value));
  try {
    const result = fn();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

test('handleGateRunnerCommand describes non-executing manifest', () => {
  const { result, lines } = captureConsole(() => handleGateRunnerCommand(['--describe']));
  expect(result).toMatchObject({
    ok: true,
    stage: 'ralph_gate_runner_manifest',
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
  expect(result.gates[0]).toMatchObject({ id: 'pre-secret-scan', required: true });
  expect(JSON.parse(lines[0]).stage).toBe('ralph_gate_runner_manifest');
});

test('handleGateRunnerCommand runs gate sequence and records bounded summary', () => {
  const rootDir = tmpRoot();
  const oldExitCode = process.exitCode;
  process.exitCode = undefined;
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const { result } = captureConsole(() => handleGateRunnerCommand([], { rootDir, spawn }));
  process.exitCode = oldExitCode;
  expect(result).toMatchObject({
    ok: true,
    stage: 'ralph_gate_runner',
    reason: null,
    failed_gate: null,
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
  expect(calls.length).toBeGreaterThan(0);
  const log = fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), 'utf8');
  expect(log).toContain('gate_runner_completed');
});

test('handleGateRunnerCommand sets exitCode on failed required gate', () => {
  const rootDir = tmpRoot();
  const oldExitCode = process.exitCode;
  process.exitCode = undefined;
  const spawn = (command, args) => {
    if (args.includes('scripts/gates/secret-scan.sh')) return { status: 1, stdout: '', stderr: 'secret scan failed' };
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const { result } = captureConsole(() => handleGateRunnerCommand([], { rootDir, spawn }));
  expect(result).toMatchObject({ ok: false, reason: 'gate_failed', failed_gate: 'pre-secret-scan' });
  expect(process.exitCode).toBe(1);
  process.exitCode = oldExitCode;
});
