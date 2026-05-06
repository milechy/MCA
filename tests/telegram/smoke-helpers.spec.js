const { test, expect } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { REQUIRED_TRANSPORT_ENV, RUN_ALL_ENV, redact, status } = require('../../scripts/telegram/check-env');
const { inspectLogs, readJsonl } = require('../../scripts/telegram/inspect-logs');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-smoke-helpers-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), '', 'utf8');
  return rootDir;
}

function appendJsonl(filePath, event) {
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

function runDefaultOffSmoke(args, { cwd = process.cwd(), env = {} } = {}) {
  return spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'telegram', 'default-off-smoke.js'), ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

test('check-env redacts bot token without exposing full secret', () => {
  expect(redact('')).toBe(null);
  expect(redact('short')).toBe('<set:redacted>');
  expect(redact('1234567890abcdef')).toBe('1234…cdef');
});

test('check-env reports missing transport env and default-off run-all gate', () => {
  const result = status({});

  expect(result.ok).toBe(false);
  expect(result.transport.map((entry) => entry.name)).toEqual(REQUIRED_TRANSPORT_ENV);
  expect(result.transport.every((entry) => entry.present === false)).toBe(true);
  expect(result.run_all).toEqual({
    env: RUN_ALL_ENV,
    value: null,
    enabled: false,
    default_off: true,
    required_value: 'true'
  });
});

test('check-env reports transport env present and run-all enabled only for explicit true', () => {
  const baseEnv = {
    TELEGRAM_BOT_TOKEN: '1234567890abcdef',
    TELEGRAM_ALLOWED_USER_IDS: '3,4',
    TELEGRAM_ALLOWED_CHAT_IDS: '10,11'
  };

  expect(status({ ...baseEnv }).ok).toBe(true);
  expect(status({ ...baseEnv }).run_all.enabled).toBe(false);
  expect(status({ ...baseEnv, [RUN_ALL_ENV]: '1' }).run_all.enabled).toBe(false);
  expect(status({ ...baseEnv, [RUN_ALL_ENV]: 'TRUE' }).run_all.enabled).toBe(false);
  expect(status({ ...baseEnv, [RUN_ALL_ENV]: 'true' }).run_all.enabled).toBe(true);
  expect(status({ ...baseEnv, [RUN_ALL_ENV]: 'true' }).run_all.default_off).toBe(false);
  expect(status({ ...baseEnv, [RUN_ALL_ENV]: 'true' }).transport[0]).toMatchObject({
    name: 'TELEGRAM_BOT_TOKEN',
    present: true,
    value: '1234…cdef'
  });
});

test('inspect-logs reads empty or missing JSONL files safely', () => {
  const rootDir = makeTempRoot();

  expect(readJsonl(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'))).toEqual([]);
  expect(readJsonl(path.join(rootDir, '.ralph', 'logs', 'missing.jsonl'))).toEqual([]);

  const result = inspectLogs({ rootDir, count: 5 });
  expect(result.audit).toEqual({ path: '.ralph/logs/audit.jsonl', count: 0, tail: [] });
  expect(result.execution).toEqual({ path: '.ralph/logs/execution.jsonl', count: 0, tail: [] });
  expect(result.shell_completion_events).toEqual([]);
});

test('inspect-logs returns bounded tails and extracts shell completion events', () => {
  const rootDir = makeTempRoot();
  const auditPath = path.join(rootDir, '.ralph', 'logs', 'audit.jsonl');
  const executionPath = path.join(rootDir, '.ralph', 'logs', 'execution.jsonl');

  appendJsonl(auditPath, { timestamp: '2026-05-06T00:00:01.000Z', event: 'telegram_command', command_type: 'ping' });
  appendJsonl(auditPath, { timestamp: '2026-05-06T00:00:02.000Z', event: 'telegram_command', command_type: 'policy' });
  appendJsonl(auditPath, { timestamp: '2026-05-06T00:00:03.000Z', event: 'telegram_command', command_type: 'run_all' });

  appendJsonl(executionPath, { timestamp: '2026-05-06T00:00:04.000Z', event: 'shell_execution_started', command_hash: 'sha256:start' });
  appendJsonl(executionPath, { timestamp: '2026-05-06T00:00:05.000Z', event: 'shell_execution_completed', command_hash: 'sha256:shell' });
  appendJsonl(executionPath, { timestamp: '2026-05-06T00:00:06.000Z', event: 'approved_shell_execution_completed', approval_id: 'APR-1', command_hash: 'sha256:approved' });

  const result = inspectLogs({ rootDir, count: 2 });

  expect(result.audit.count).toBe(3);
  expect(result.audit.tail.map((event) => event.command_type)).toEqual(['policy', 'run_all']);
  expect(result.execution.count).toBe(3);
  expect(result.execution.tail.map((event) => event.event)).toEqual(['shell_execution_completed', 'approved_shell_execution_completed']);
  expect(result.shell_completion_events).toEqual([
    {
      timestamp: '2026-05-06T00:00:05.000Z',
      event: 'shell_execution_completed',
      command_hash: 'sha256:shell',
      approval_id: null
    },
    {
      timestamp: '2026-05-06T00:00:06.000Z',
      event: 'approved_shell_execution_completed',
      command_hash: 'sha256:approved',
      approval_id: 'APR-1'
    }
  ]);
});

test('default-off-smoke CLI prints usage and exits without side effects when args are missing', () => {
  const rootDir = makeTempRoot();
  const result = runDefaultOffSmoke([], { cwd: rootDir, env: { [RUN_ALL_ENV]: '' } });

  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Usage: node scripts/telegram/default-off-smoke.js <approval_id> <.ralph/tmp/plan.json>');
  expect(result.stdout).toBe('');
  expect(fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), 'utf8')).toBe('');
});

test('default-off-smoke CLI refuses to run when Telegram run-all env gate is true', () => {
  const rootDir = makeTempRoot();
  const planPath = path.join(rootDir, '.ralph', 'tmp', 'plan.json');
  fs.writeFileSync(planPath, '{}\n', 'utf8');

  const result = runDefaultOffSmoke(['APR-TEST', '.ralph/tmp/plan.json'], { cwd: rootDir, env: { [RUN_ALL_ENV]: 'true' } });

  expect(result.status).toBe(3);
  expect(result.stderr).toContain('Refusing default-off smoke because RALPH_TELEGRAM_RUN_ALL_ENABLED=true. Unset it first.');
  expect(result.stdout).toBe('');
  expect(fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), 'utf8')).toBe('');
});

test('default-off-smoke CLI fails safely when plan file is missing', () => {
  const rootDir = makeTempRoot();
  const result = runDefaultOffSmoke(['APR-TEST', '.ralph/tmp/missing.json'], { cwd: rootDir, env: { [RUN_ALL_ENV]: '' } });

  expect(result.status).toBe(4);
  expect(result.stderr).toContain('Plan file not found: .ralph/tmp/missing.json');
  expect(result.stdout).toBe('');
  expect(fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), 'utf8')).toBe('');
});
