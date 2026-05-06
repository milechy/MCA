const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleUpdate } = require('../../src/telegram/runtime');
const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { EMPTY_DIFF_HASH, TELEGRAM_RUN_ALL_ENV } = require('../../src/telegram/execution-adapter');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-runtime-safety-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'state.json'), `${JSON.stringify({ loop_id: 'telegram-runtime-safety-test', phase: 'IDLE', current_story_id: null, iteration: 0, consecutive_failures: 0, active_mode: 'approval', current_approval_id: null, last_green_commit: null, security_stop: false, updated_at: '2026-05-06T00:00:00+09:00' }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'mode.json'), `${JSON.stringify({ mode: 'approval', effective_until: null, auto_revert_to: null, changed_by: { channel: 'manual', user: 'test' }, policy_version: 'approval-policy-v1.4', reason: 'telegram_runtime_safety_test_setup', updated_at: '2026-05-06T00:00:00+09:00' }, null, 2)}\n`, 'utf8');
  return rootDir;
}

function runtimeConfig() {
  return { dry_run: true, allowed_user_ids: [3], allowed_chat_ids: [10] };
}

function runtimeRoles() {
  return { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] };
}

function update({ text = '/ping', userId = 3, chatId = 10 } = {}) {
  return { update_id: 1, message: { text, from: { id: userId }, chat: { id: chatId } } };
}

function sampleRunAllPlan(overrides = {}) {
  return {
    story_id: 'STORY-TELEGRAM-RUNTIME-SAFETY-RUN-ALL',
    mode: 'approval',
    target_env: 'staging',
    summary: 'Telegram runtime safety run-all smoke test',
    objective: 'Ensure final operator safety boundaries hold',
    planned_files: [],
    migration_plan: { target: 'staging', sql: '' },
    allowed_user_ids: [3],
    ...overrides
  };
}

function writeTmpPlan(rootDir, fileName, plan) {
  const planPath = `.ralph/tmp/${fileName}`;
  fs.writeFileSync(path.join(rootDir, planPath), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return planPath;
}

function createApprovedPlan(rootDir, plan) {
  const approval = createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: `APR-TELEGRAM-SAFETY-${Date.now()}`,
    allowed_user_ids: [3],
    pre_exec_diff_hash: EMPTY_DIFF_HASH
  });
  return approveApprovalRecordOnly(approval.approval_id, 3, { rootDir, channel: 'telegram' });
}

function readFile(rootDir, relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function readAuditEvents(rootDir) {
  const content = readFile(rootDir, '.ralph/logs/audit.jsonl').trim();
  if (!content) return [];
  return content.split('\n').map((line) => JSON.parse(line));
}

function expectNoExecutionSideEffects(rootDir) {
  expect(readFile(rootDir, '.ralph/logs/execution.jsonl')).toBe('');
}

function expectUnauthorizedAudit(rootDir, expected) {
  const events = readAuditEvents(rootDir);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: 'telegram_command',
    command_type: 'unauthorized',
    ok: false,
    execution_connected: false,
    ...expected
  });
  expect(events[0]).not.toHaveProperty('summary');
  expect(events[0]).not.toHaveProperty('result');
  expect(events[0]).not.toHaveProperty('response');
}

function expectNoShellCompletion(rootDir) {
  const executionLog = readFile(rootDir, '.ralph/logs/execution.jsonl');
  expect(executionLog).not.toContain('shell_execution_completed');
  expect(executionLog).not.toContain('approved_shell_execution_completed');
}

test('unauthorized Telegram user is audited compactly but never reaches execution', async () => {
  const rootDir = makeTempRoot();
  const result = await handleUpdate(update({ text: '/run-all APR-ANY .ralph/tmp/any.json', userId: 999, chatId: 10 }), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: { [TELEGRAM_RUN_ALL_ENV]: 'true' }
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('telegram_user_not_allowed');
  expectUnauthorizedAudit(rootDir, { user_id: 999, chat_id: 10, reason: 'telegram_user_not_allowed' });
  expectNoExecutionSideEffects(rootDir);
});

test('unauthorized Telegram chat is audited compactly but never reaches execution', async () => {
  const rootDir = makeTempRoot();
  const result = await handleUpdate(update({ text: '/run-all APR-ANY .ralph/tmp/any.json', userId: 3, chatId: 999 }), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: { [TELEGRAM_RUN_ALL_ENV]: 'true' }
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe('telegram_chat_not_allowed');
  expectUnauthorizedAudit(rootDir, { user_id: 3, chat_id: 999, reason: 'telegram_chat_not_allowed' });
  expectNoExecutionSideEffects(rootDir);
});

test('unknown command is audited compactly but never touches execution log', async () => {
  const rootDir = makeTempRoot();
  const result = await handleUpdate(update({ text: '/deploy production now' }), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: { [TELEGRAM_RUN_ALL_ENV]: 'true' }
  });

  expect(result.ok).toBe(true);
  expect(result.response_text).toContain('Unknown or unsupported command');
  expectNoExecutionSideEffects(rootDir);
  const event = readAuditEvents(rootDir).at(-1);
  expect(event).toMatchObject({ event: 'telegram_command', command_type: 'unknown', ok: true, reason: null, execution_connected: false });
  expect(event).not.toHaveProperty('summary');
  expect(event).not.toHaveProperty('result');
  expect(event).not.toHaveProperty('response');
});

test('policy env gate true matches run-all runtime wiring', async () => {
  const rootDir = makeTempRoot();
  const policy = await handleUpdate(update({ text: '/policy' }), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: { [TELEGRAM_RUN_ALL_ENV]: 'true' }
  });

  expect(policy.response.policy.telegram_run_all_enabled).toBe(true);
  expect(policy.response.policy.telegram_shell_execution_connected).toBe(true);

  const plan = sampleRunAllPlan({ story_id: 'STORY-TELEGRAM-RUNTIME-SAFETY-GATE-TRUE' });
  const planPath = writeTmpPlan(rootDir, 'runtime-safety-run-all-plan.json', plan);
  const approval = createApprovedPlan(rootDir, plan);
  const runAll = await handleUpdate(update({ text: `/run-all ${approval.approval_id} ${planPath}` }), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: { [TELEGRAM_RUN_ALL_ENV]: 'true' }
  });

  expect(runAll.response.summary.run_all_enabled).toBe(true);
  expect(runAll.response.summary.wired_to_runtime).toBe(true);
  expect(runAll.response.summary.execution_connected).toBe(true);
  expect(runAll.response.summary.reason).toBe('shell_execution_failed');
  expect(runAll.response.summary.commands_executed).toEqual(['scripts/gates/run-all.sh']);
  expect(runAll.response.summary.files_modified).toEqual([]);
  expectNoShellCompletion(rootDir);
});

test('policy env gate off matches run-all preflight-only behavior', async () => {
  const rootDir = makeTempRoot();
  const policy = await handleUpdate(update({ text: '/policy' }), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: {}
  });

  expect(policy.response.policy.telegram_run_all_enabled).toBe(false);
  expect(policy.response.policy.telegram_shell_execution_connected).toBe(false);

  const plan = sampleRunAllPlan({ story_id: 'STORY-TELEGRAM-RUNTIME-SAFETY-GATE-OFF' });
  const planPath = writeTmpPlan(rootDir, 'runtime-safety-run-all-plan.json', plan);
  const approval = createApprovedPlan(rootDir, plan);
  const runAll = await handleUpdate(update({ text: `/run-all ${approval.approval_id} ${planPath}` }), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: {}
  });

  expect(runAll.response.summary.run_all_enabled).toBe(false);
  expect(runAll.response.summary.wired_to_runtime).toBe(false);
  expect(runAll.response.summary.execution_connected).toBe(false);
  expect(runAll.response.summary.reason).toBe('READY_BUT_NOT_EXECUTED');
  expectNoShellCompletion(rootDir);
});

test('unsafe run-all path never reaches shell execution even when env gate is true', async () => {
  const rootDir = makeTempRoot();
  const result = await handleUpdate(update({ text: '/run-all APR-UNSAFE ../../tmp/evil.json' }), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: { [TELEGRAM_RUN_ALL_ENV]: 'true' }
  });

  expect(result.ok).toBe(true);
  expect(result.response.summary).toMatchObject({
    ok: false,
    reason: 'plan_path_not_allowed',
    run_all_enabled: true,
    wired_to_runtime: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: []
  });
  expectNoShellCompletion(rootDir);
});
