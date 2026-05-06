#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { runAllFromTelegram, EMPTY_DIFF_HASH } = require('../../src/telegram/execution-adapter');

function usage() {
  return 'Usage: node scripts/telegram/default-off-smoke.js <approval_id> <.ralph/tmp/plan.json>';
}

function main() {
  const [approvalId, planPath] = process.argv.slice(2);
  if (!approvalId || !planPath) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (process.env.RALPH_TELEGRAM_RUN_ALL_ENABLED === 'true') {
    console.error('Refusing default-off smoke because RALPH_TELEGRAM_RUN_ALL_ENABLED=true. Unset it first.');
    process.exitCode = 3;
    return;
  }

  const rootDir = process.cwd();
  const resolvedPlan = path.join(rootDir, planPath);
  if (!fs.existsSync(resolvedPlan)) {
    console.error(`Plan file not found: ${planPath}`);
    process.exitCode = 4;
    return;
  }

  const result = runAllFromTelegram({
    rootDir,
    approval_id: approvalId,
    plan_path: planPath,
    current_diff_hash: EMPTY_DIFF_HASH,
    env: process.env
  });

  console.log(JSON.stringify({
    ok: result.ok,
    reason: result.reason,
    stage: result.stage || null,
    run_all_enabled: result.run_all_enabled,
    wired_to_runtime: result.wired_to_runtime,
    execution_connected: result.execution_connected,
    commands_executed: result.commands_executed,
    files_modified: result.files_modified,
    approval_id: result.approval_id || approvalId,
    plan_path: result.plan_path || planPath,
    log_path: result.log_path || '.ralph/logs/execution.jsonl'
  }, null, 2));

  if (!(result.ok === true && result.reason === 'READY_BUT_NOT_EXECUTED' && result.run_all_enabled === false && result.execution_connected === false)) {
    process.exitCode = 1;
  }
}

if (require.main === module) main();
