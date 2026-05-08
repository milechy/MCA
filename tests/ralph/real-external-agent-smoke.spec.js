const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { timestampId, commandExists, runRealExternalAgentSmoke } = require('../../scripts/ralph/real-external-agent-smoke');

function tmpRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-real-external-agent-smoke-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp'), { recursive: true });
  return rootDir;
}

test('timestampId is deterministic', () => {
  expect(timestampId('JOB-EXTAGENT', new Date('2026-05-08T10:20:30.000Z'))).toBe('JOB-EXTAGENT-20260508102030');
});

test('commandExists returns false for missing runtime command', () => {
  expect(commandExists('definitely-missing-ralph-external-agent-runtime')).toBe(false);
});

test('runRealExternalAgentSmoke skips when runtime is not installed', () => {
  const result = runRealExternalAgentSmoke({
    rootDir: tmpRoot(),
    gateway_type: 'nemoclaw',
    command: 'definitely-missing-ralph-external-agent-runtime',
    now: () => new Date('2026-05-08T10:20:30.000Z')
  });
  expect(result).toMatchObject({
    ok: true,
    skipped: true,
    reason: 'runtime_not_installed',
    gateway_type: 'nemoclaw',
    job_id: 'JOB-EXTAGENT-20260508102030',
    approval_id: 'APR-EXTAGENT-REAL-SMOKE-20260508102030',
    runtime_installed: false,
    execution_connected: false,
    real_gateway_process_started: false,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('runRealExternalAgentSmoke blocks installed runtime without explicit approval', () => {
  const result = runRealExternalAgentSmoke({
    rootDir: tmpRoot(),
    gateway_type: 'nemoclaw',
    command: process.execPath,
    explicit_runtime_approval: false,
    now: () => new Date('2026-05-08T10:20:30.000Z')
  });
  expect(result).toMatchObject({
    ok: false,
    skipped: false,
    reason: 'explicit_runtime_approval_required',
    runtime_installed: true,
    execution_connected: false,
    real_gateway_process_started: false,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('runRealExternalAgentSmoke blocks unsupported gateway', () => {
  const result = runRealExternalAgentSmoke({ rootDir: tmpRoot(), gateway_type: 'bash', now: () => new Date('2026-05-08T10:20:30.000Z') });
  expect(result).toMatchObject({ ok: false, reason: 'gateway_type_not_allowed', execution_connected: false });
});
