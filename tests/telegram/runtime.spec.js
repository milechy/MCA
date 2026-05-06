const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sendMessage, handleUpdate } = require('../../src/telegram/runtime');
const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { EMPTY_DIFF_HASH, TELEGRAM_RUN_ALL_ENV } = require('../../src/telegram/execution-adapter');

function makeTempRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-runtime-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(rootDir, '.ralph', 'state.json'),
    `${JSON.stringify({
      loop_id: 'telegram-runtime-test',
      phase: 'IDLE',
      current_story_id: null,
      iteration: 0,
      consecutive_failures: 0,
      active_mode: 'approval',
      current_approval_id: null,
      last_green_commit: null,
      security_stop: false,
      updated_at: '2026-05-06T00:00:00+09:00'
    }, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, '.ralph', 'mode.json'),
    `${JSON.stringify({
      mode: 'approval',
      effective_until: null,
      auto_revert_to: null,
      changed_by: { channel: 'manual', user: 'test' },
      policy_version: 'approval-policy-v1.4',
      reason: 'telegram_runtime_test_setup',
      updated_at: '2026-05-06T00:00:00+09:00'
    }, null, 2)}\n`,
    'utf8'
  );
  return rootDir;
}

function writeExecutableRunAll(rootDir) {
  const scriptPath = path.join(rootDir, 'scripts', 'gates', 'run-all.sh');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\necho "telegram runtime run-all smoke"\n', 'utf8');
  fs.chmodSync(scriptPath, 0o755);
}

function sampleRunAllPlan(overrides = {}) {
  return {
    story_id: 'STORY-TELEGRAM-RUNTIME-RUN-ALL',
    mode: 'approval',
    target_env: 'staging',
    summary: 'Telegram runtime run-all smoke test',
    objective: 'Ensure runtime dry-run respects Telegram run-all execution gate',
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
    approval_id: 'APR-TELEGRAM-RUNTIME-RUN-ALL',
    allowed_user_ids: [3],
    pre_exec_diff_hash: EMPTY_DIFF_HASH
  });
  return approveApprovalRecordOnly(approval.approval_id, 3, { rootDir, channel: 'telegram' });
}

function update(text = '/ping') {
  return {
    update_id: 1,
    message: {
      text,
      from: { id: 3 },
      chat: { id: 10 }
    }
  };
}

function runtimeConfig() {
  return {
    dry_run: true,
    allowed_user_ids: [3],
    allowed_chat_ids: [10]
  };
}

function runtimeRoles() {
  return {
    owner_user_ids: [1],
    admin_user_ids: [2],
    reviewer_user_ids: [3],
    observer_user_ids: [4]
  };
}

function expectCompressedRunAllText(text) {
  expect(text).not.toContain('stdout');
  expect(text).not.toContain('execution_preflight');
  expect(text).not.toContain('command_preflight');
  expect(text).not.toContain('policy');
}

test('sendMessage does not call Telegram API in dry-run mode', async () => {
  const result = await sendMessage({ dry_run: true }, 10, 'pong');

  expect(result).toEqual({ dry_run: true, chat_id: 10, text: 'pong' });
});

test('handleUpdate processes authorized command and returns response text', async () => {
  const result = await handleUpdate(update('/ping'), {
    rootDir: makeTempRoot(),
    config: runtimeConfig(),
    roles: runtimeRoles()
  });

  expect(result.ok).toBe(true);
  expect(result.response_text).toBe('pong');
});

test('handleUpdate keeps /run-all preflight-only when Telegram run-all env gate is off', async () => {
  const rootDir = makeTempRoot();
  const plan = sampleRunAllPlan({ story_id: 'STORY-TELEGRAM-RUNTIME-RUN-ALL-DEFAULT-OFF' });
  const planPath = writeTmpPlan(rootDir, 'runtime-run-all-plan.json', plan);
  const approval = createApprovedPlan(rootDir, plan);

  const result = await handleUpdate(update(`/run-all ${approval.approval_id} ${planPath}`), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: {}
  });

  expect(result.ok).toBe(true);
  expect(result.response.wired_to_runtime).toBe(false);
  expect(result.response.result.ok).toBe(true);
  expect(result.response.result.reason).toBe('READY_BUT_NOT_EXECUTED');
  expect(result.response.result.run_all_enabled).toBe(false);
  expect(result.response.result.execution_connected).toBe(false);
  expect(result.response.result.commands_executed).toEqual([]);
  expect(result.response.result.files_modified).toEqual([]);
  expect(result.response.summary).toMatchObject({
    ok: true,
    reason: 'READY_BUT_NOT_EXECUTED',
    run_all_enabled: false,
    wired_to_runtime: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    log_path: '.ralph/logs/execution.jsonl'
  });
  expectCompressedRunAllText(result.response_text);

  const executionLog = fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), 'utf8');
  expect(executionLog).not.toContain('shell_execution_completed');
  expect(executionLog).not.toContain('approved_shell_execution_completed');
});

test('handleUpdate executes /run-all when Telegram run-all env gate is true while Telegram send stays dry-run', async () => {
  const rootDir = makeTempRoot();
  writeExecutableRunAll(rootDir);
  const plan = sampleRunAllPlan({ story_id: 'STORY-TELEGRAM-RUNTIME-RUN-ALL-GATE-TRUE' });
  const planPath = writeTmpPlan(rootDir, 'runtime-run-all-plan.json', plan);
  const approval = createApprovedPlan(rootDir, plan);

  const result = await handleUpdate(update(`/run-all ${approval.approval_id} ${planPath}`), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: { [TELEGRAM_RUN_ALL_ENV]: 'true' }
  });

  expect(result.ok).toBe(true);
  expect(result.response.wired_to_runtime).toBe(true);
  expect(result.response.result.ok).toBe(true);
  expect(result.response.result.executor).toBe('shell');
  expect(result.response.result.command).toBe('scripts/gates/run-all.sh');
  expect(result.response.result.exit_code).toBe(0);
  expect(result.response.result.stdout.trim()).toBe('telegram runtime run-all smoke');
  expect(result.response.result.run_all_enabled).toBe(true);
  expect(result.response.result.execution_connected).toBe(true);
  expect(result.response.result.commands_executed).toEqual(['scripts/gates/run-all.sh']);
  expect(result.response.result.files_modified).toEqual([]);
  expect(result.response.summary).toMatchObject({
    ok: true,
    executor: 'shell',
    command: 'scripts/gates/run-all.sh',
    exit_code: 0,
    run_all_enabled: true,
    wired_to_runtime: true,
    execution_connected: true,
    commands_executed: ['scripts/gates/run-all.sh'],
    files_modified: [],
    log_path: '.ralph/logs/execution.jsonl'
  });
  expectCompressedRunAllText(result.response_text);
  expect(result.response_text).not.toContain('telegram runtime run-all smoke');

  const executionLog = fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), 'utf8');
  expect(executionLog).toContain('shell_execution_completed');
  expect(executionLog).toContain('approved_shell_execution_completed');
});

test('handleUpdate returns compressed /run-all failure response', async () => {
  const rootDir = makeTempRoot();

  const result = await handleUpdate(update('/run-all APR-MISSING ../unsafe-plan.json'), {
    rootDir,
    config: runtimeConfig(),
    roles: runtimeRoles(),
    env: { [TELEGRAM_RUN_ALL_ENV]: 'true' }
  });

  expect(result.ok).toBe(true);
  expect(result.response.wired_to_runtime).toBe(false);
  expect(result.response.result.ok).toBe(false);
  expect(result.response.result.reason).toBe('plan_path_not_allowed');
  expect(result.response.summary).toMatchObject({
    ok: false,
    reason: 'plan_path_not_allowed',
    run_all_enabled: false,
    wired_to_runtime: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    log_path: '.ralph/logs/execution.jsonl'
  });
  expect(result.response_text).toContain('Run-all failed: plan_path_not_allowed');
  expectCompressedRunAllText(result.response_text);

  const executionLog = fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'execution.jsonl'), 'utf8');
  expect(executionLog).not.toContain('shell_execution_completed');
  expect(executionLog).not.toContain('approved_shell_execution_completed');
});
