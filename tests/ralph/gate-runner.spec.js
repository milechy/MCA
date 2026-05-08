const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GATE_SEQUENCE, validateGate, describeGateSequence, runGateSequence } = require('../../src/ralph/gate-runner');

function tmpRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-gates-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  return rootDir;
}

test('GATE_SEQUENCE encodes required v0.2 gate order with pre and post secret scans', () => {
  expect(GATE_SEQUENCE.map((gate) => gate.id)).toEqual([
    'pre-secret-scan',
    'lint',
    'typecheck',
    'unit-tests',
    'ralph-tests',
    'telegram-tests',
    'build',
    'supabase-local',
    'generated-types-check',
    'playwright-smoke',
    'playwright-regression',
    'post-secret-scan',
    'dependency-audit'
  ]);
  expect(GATE_SEQUENCE[0]).toMatchObject({ id: 'pre-secret-scan', required: true });
  expect(GATE_SEQUENCE.find((gate) => gate.id === 'post-secret-scan')).toMatchObject({ required: true });
});

test('validateGate blocks deploy migration git mutation and shell token commands', () => {
  expect(validateGate({ id: 'safe', command: 'npm', args: ['run', 'test'], required: true }).ok).toBe(true);
  expect(validateGate({ id: 'deploy', command: 'npm', args: ['run', 'deploy'], required: true }).reason).toBe('gate_forbidden_command');
  expect(validateGate({ id: 'push', command: 'git', args: ['push'], required: true }).reason).toBe('gate_forbidden_command');
  expect(validateGate({ id: 'shell', command: 'bash', args: ['-lc', 'echo ok'], required: true }).reason).toBe('gate_shell_token_not_allowed');
});

test('describeGateSequence returns non-mutating bounded gate contract', () => {
  const description = describeGateSequence([{ id: 'pre-secret-scan', command: 'bash', args: ['scripts/gates/secret-scan.sh'], required: true, phase: 'pre' }]);
  expect(description).toEqual([{
    order: 1,
    id: 'pre-secret-scan',
    phase: 'pre',
    required: true,
    command: 'bash scripts/gates/secret-scan.sh',
    mutation_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    commit_allowed: false,
    push_allowed: false
  }]);
});

test('runGateSequence stops on required failure and logs bounded summary', () => {
  const rootDir = tmpRoot();
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args.includes('fail-required')) return { status: 1, stdout: '', stderr: 'failed' };
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const gates = [
    { id: 'required-ok', command: 'npm', args: ['run', 'test'], required: true, phase: 'test' },
    { id: 'required-fail', command: 'npm', args: ['run', 'fail-required'], required: true, phase: 'test' },
    { id: 'not-run', command: 'npm', args: ['run', 'test'], required: true, phase: 'test' }
  ];
  const result = runGateSequence({ rootDir, gates, spawn });
  expect(result).toMatchObject({
    ok: false,
    stage: 'ralph_gate_runner',
    reason: 'gate_failed',
    failed_gate: 'required-fail',
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
  expect(calls).toHaveLength(2);
  const log = fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), 'utf8');
  expect(log).toContain('gate_runner_failed');
});

test('runGateSequence passes when all required gates pass', () => {
  const rootDir = tmpRoot();
  const result = runGateSequence({
    rootDir,
    gates: [
      { id: 'pre-secret-scan', command: 'bash', args: ['scripts/gates/secret-scan.sh'], required: true, phase: 'pre' },
      { id: 'lint', command: 'npm', args: ['run', 'lint', '--if-present'], required: false, phase: 'quality' }
    ],
    spawn: () => ({ status: 0, stdout: 'ok', stderr: '' })
  });
  expect(result).toMatchObject({ ok: true, reason: null, failed_gate: null, next_action: 'continue_after_green_gates' });
});
