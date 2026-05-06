const { test, expect } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDryTransportSmoke } = require('../../scripts/telegram/dry-transport-smoke');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-dry-transport-smoke-'));
}

function runCli({ cwd, env = {} }) {
  return spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'telegram', 'dry-transport-smoke.js')], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

test('dry transport smoke validates read-only and default-off run-all path without real Telegram API', async () => {
  const rootDir = makeTempRoot();
  const result = await runDryTransportSmoke({ rootDir, env: { RALPH_TELEGRAM_RUN_ALL_ENABLED: '' } });

  expect(result.ok).toBe(true);
  expect(result.dry_run).toBe(true);
  expect(result.run_all_enabled).toBe(false);
  expect(result.results.map((entry) => entry.command)).toEqual([
    '/ping',
    '/status',
    '/policy',
    '/run-all APR-TELEGRAM-DRY-TRANSPORT-SMOKE .ralph/tmp/dry-transport-run-all-plan.json',
    '/run-all APR-UNSAFE ../../tmp/evil.json'
  ]);

  const defaultOff = result.results.find((entry) => entry.command.startsWith('/run-all APR-TELEGRAM-DRY-TRANSPORT-SMOKE'));
  expect(defaultOff.summary).toMatchObject({
    ok: true,
    reason: 'READY_BUT_NOT_EXECUTED',
    run_all_enabled: false,
    wired_to_runtime: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: []
  });

  const unsafe = result.results.find((entry) => entry.command.startsWith('/run-all APR-UNSAFE'));
  expect(unsafe.summary).toMatchObject({
    ok: false,
    reason: 'plan_path_not_allowed',
    wired_to_runtime: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: []
  });

  const executionLog = fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), 'utf8');
  expect(executionLog).not.toContain('shell_execution_completed');
  expect(executionLog).not.toContain('approved_shell_execution_completed');
});

test('dry transport smoke refuses to run when real run-all env gate is true', async () => {
  const result = await runDryTransportSmoke({
    rootDir: makeTempRoot(),
    env: { RALPH_TELEGRAM_RUN_ALL_ENABLED: 'true' }
  });

  expect(result).toEqual({
    ok: false,
    reason: 'dry_transport_refuses_real_run_all_gate',
    results: []
  });
});

test('dry transport smoke CLI exits non-zero when real run-all env gate is true', () => {
  const rootDir = makeTempRoot();
  const result = runCli({ cwd: rootDir, env: { RALPH_TELEGRAM_RUN_ALL_ENABLED: 'true' } });

  expect(result.status).toBe(1);
  const parsed = JSON.parse(result.stdout);
  expect(parsed).toEqual({
    ok: false,
    reason: 'dry_transport_refuses_real_run_all_gate',
    results: []
  });
});

test('dry transport smoke CLI succeeds with default-off gate', () => {
  const rootDir = makeTempRoot();
  const result = runCli({ cwd: rootDir, env: { RALPH_TELEGRAM_RUN_ALL_ENABLED: '' } });

  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.dry_run).toBe(true);
  expect(parsed.run_all_enabled).toBe(false);
});
