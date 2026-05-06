#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { handleUpdate } = require('../../src/telegram/runtime');
const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { evaluateRisk } = require('../../src/ralph/risk-evaluator');
const { EMPTY_DIFF_HASH } = require('../../src/telegram/execution-adapter');

const FIXED_USER_ID = 3;
const FIXED_CHAT_ID = 10;

function ensureRuntimeState(rootDir) {
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });

  const files = [
    ['.ralph/approval-log.jsonl', ''],
    ['.ralph/logs/audit.jsonl', ''],
    ['.ralph/logs/execution.jsonl', '']
  ];

  for (const [relativePath, content] of files) {
    const filePath = path.join(rootDir, relativePath);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, 'utf8');
  }

  const statePath = path.join(rootDir, '.ralph', 'state.json');
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, `${JSON.stringify({
      loop_id: 'telegram-dry-transport-smoke',
      phase: 'IDLE',
      current_story_id: null,
      iteration: 0,
      consecutive_failures: 0,
      active_mode: 'approval',
      current_approval_id: null,
      last_green_commit: null,
      security_stop: false,
      updated_at: '2026-05-06T00:00:00+09:00'
    }, null, 2)}\n`, 'utf8');
  }

  const modePath = path.join(rootDir, '.ralph', 'mode.json');
  if (!fs.existsSync(modePath)) {
    fs.writeFileSync(modePath, `${JSON.stringify({
      mode: 'approval',
      effective_until: null,
      auto_revert_to: null,
      changed_by: { channel: 'manual', user: 'telegram-dry-transport-smoke' },
      policy_version: 'approval-policy-v1.4',
      reason: 'telegram_dry_transport_smoke_setup',
      updated_at: '2026-05-06T00:00:00+09:00'
    }, null, 2)}\n`, 'utf8');
  }
}

function telegramUpdate(text, { userId = FIXED_USER_ID, chatId = FIXED_CHAT_ID } = {}) {
  return {
    update_id: Date.now(),
    message: {
      text,
      from: { id: userId },
      chat: { id: chatId }
    }
  };
}

function runtimeOptions(rootDir, env = process.env) {
  return {
    rootDir,
    config: {
      dry_run: true,
      allowed_user_ids: [FIXED_USER_ID],
      allowed_chat_ids: [FIXED_CHAT_ID]
    },
    roles: {
      owner_user_ids: [1],
      admin_user_ids: [2],
      reviewer_user_ids: [FIXED_USER_ID],
      observer_user_ids: [4]
    },
    env: { ...env, RALPH_TELEGRAM_RUN_ALL_ENABLED: '' }
  };
}

function samplePlan() {
  return {
    story_id: 'STORY-TELEGRAM-DRY-TRANSPORT-SMOKE',
    mode: 'approval',
    target_env: 'staging',
    summary: 'Telegram dry transport smoke run-all preflight test',
    objective: 'Validate runtime dry transport without real Telegram API calls',
    planned_files: [],
    migration_plan: { target: 'staging', sql: '' },
    allowed_user_ids: [FIXED_USER_ID]
  };
}

function createApprovedDryPlan(rootDir) {
  const plan = samplePlan();
  const planPath = '.ralph/tmp/dry-transport-run-all-plan.json';
  fs.writeFileSync(path.join(rootDir, planPath), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  const approval = createApproval(plan, evaluateRisk(plan), {
    rootDir,
    approval_id: 'APR-TELEGRAM-DRY-TRANSPORT-SMOKE',
    allowed_user_ids: [FIXED_USER_ID],
    pre_exec_diff_hash: EMPTY_DIFF_HASH
  });
  approveApprovalRecordOnly(approval.approval_id, FIXED_USER_ID, { rootDir, channel: 'telegram' });

  return { approval_id: approval.approval_id, plan_path: planPath };
}

function summarizeResponse(command, response) {
  return {
    command,
    ok: response.ok,
    reason: response.reason || null,
    response_text: response.response_text || null,
    summary: response.response ? response.response.summary || null : null,
    policy: response.response ? response.response.policy || null : null
  };
}

async function runDryTransportSmoke({ rootDir = process.cwd(), env = process.env } = {}) {
  if (env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true') {
    return {
      ok: false,
      reason: 'dry_transport_refuses_real_run_all_gate',
      results: []
    };
  }

  ensureRuntimeState(rootDir);
  const options = runtimeOptions(rootDir, env);
  const approved = createApprovedDryPlan(rootDir);

  const commands = [
    '/ping',
    '/status',
    '/policy',
    `/run-all ${approved.approval_id} ${approved.plan_path}`,
    '/run-all APR-UNSAFE ../../tmp/evil.json'
  ];

  const results = [];
  for (const command of commands) {
    const response = await handleUpdate(telegramUpdate(command), options);
    results.push(summarizeResponse(command, response));
  }

  const runAllDefaultOff = results.find((result) => result.command.startsWith('/run-all APR-TELEGRAM-DRY-TRANSPORT-SMOKE'));
  const unsafe = results.find((result) => result.command.startsWith('/run-all APR-UNSAFE'));

  const ok = results.every((result) => result.ok === true)
    && runAllDefaultOff
    && runAllDefaultOff.summary
    && runAllDefaultOff.summary.reason === 'READY_BUT_NOT_EXECUTED'
    && runAllDefaultOff.summary.run_all_enabled === false
    && runAllDefaultOff.summary.execution_connected === false
    && unsafe
    && unsafe.summary
    && unsafe.summary.reason === 'plan_path_not_allowed'
    && unsafe.summary.execution_connected === false;

  return {
    ok: Boolean(ok),
    reason: ok ? null : 'dry_transport_smoke_failed',
    dry_run: true,
    run_all_enabled: false,
    results
  };
}

async function main() {
  const result = await runDryTransportSmoke({ rootDir: process.cwd(), env: process.env });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  FIXED_USER_ID,
  FIXED_CHAT_ID,
  ensureRuntimeState,
  telegramUpdate,
  runDryTransportSmoke
};
