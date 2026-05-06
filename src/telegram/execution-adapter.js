const fs = require('node:fs');
const path = require('node:path');
const { runExecutionHarness } = require('../ralph/execution-harness');
const { verifyExecutionPreflight } = require('../ralph/execution-preflight');
const { validateCommandRequest } = require('../ralph/command-allowlist');
const { evaluateShellExecutionPolicy } = require('../ralph/shell-execution-policy');
const { runApprovedShellCommand } = require('../ralph/shell-approved-executor');

const EMPTY_DIFF_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TELEGRAM_RUN_ALL_ENV = 'RALPH_TELEGRAM_RUN_ALL_ENABLED';

function isAllowedTmpPlanPath(planPath) {
  if (!planPath || typeof planPath !== 'string') return false;
  if (path.isAbsolute(planPath)) return false;
  if (planPath.includes('..')) return false;
  return /^\.ralph\/tmp\/[A-Za-z0-9._-]+\.json$/.test(planPath);
}

function telegramRunAllEnabled(env = process.env) {
  return env[TELEGRAM_RUN_ALL_ENV] === 'true';
}

function readAllowedPlan(rootDir, planPath) {
  if (!isAllowedTmpPlanPath(planPath)) {
    return {
      ok: false,
      reason: 'plan_path_not_allowed',
      allowed_pattern: '.ralph/tmp/*.json'
    };
  }

  const fullPlanPath = path.join(rootDir, planPath);
  if (!fs.existsSync(fullPlanPath)) {
    return { ok: false, reason: 'plan_file_not_found', plan_path: planPath };
  }

  return {
    ok: true,
    plan: JSON.parse(fs.readFileSync(fullPlanPath, 'utf8')),
    plan_path: planPath
  };
}

function executeNoopFromTelegram(approvalId, planPath, options = {}) {
  const rootDir = options.rootDir || process.cwd();

  if (!approvalId) {
    return { ok: false, reason: 'approval_id_required', wired_to_runtime: false };
  }

  const planRead = readAllowedPlan(rootDir, planPath);
  if (!planRead.ok) {
    return { ...planRead, wired_to_runtime: false };
  }

  const result = runExecutionHarness(approvalId, planRead.plan, {
    rootDir,
    executor: 'noop',
    current_diff_hash: options.current_diff_hash || EMPTY_DIFF_HASH
  });

  return {
    ...result,
    wired_to_runtime: false,
    execution_connected: false,
    plan_path: planPath
  };
}

function preflightRunAllFromTelegram(approvalId, planPath, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const env = options.env || process.env;
  const runAllEnabled = telegramRunAllEnabled(env);

  if (!approvalId) {
    return { ok: false, reason: 'approval_id_required', wired_to_runtime: false, execution_connected: false };
  }

  const planRead = readAllowedPlan(rootDir, planPath);
  if (!planRead.ok) {
    return { ...planRead, wired_to_runtime: false, execution_connected: false };
  }

  const executionPreflight = verifyExecutionPreflight(approvalId, planRead.plan, {
    rootDir,
    current_diff_hash: options.current_diff_hash || EMPTY_DIFF_HASH,
    mode: options.mode
  });

  if (!executionPreflight.ok) {
    return {
      ok: false,
      reason: executionPreflight.reason,
      stage: 'execution_preflight',
      execution_preflight: executionPreflight,
      wired_to_runtime: false,
      execution_connected: false,
      run_all_enabled: runAllEnabled,
      plan_path: planPath
    };
  }

  const commandPreflight = validateCommandRequest({
    command: 'scripts/gates/run-all.sh',
    args: [],
    cwd: '.'
  });

  if (!commandPreflight.ok) {
    return {
      ok: false,
      reason: commandPreflight.reason,
      stage: 'command_allowlist',
      execution_preflight: executionPreflight,
      command_preflight: commandPreflight,
      wired_to_runtime: false,
      execution_connected: false,
      run_all_enabled: runAllEnabled,
      plan_path: planPath
    };
  }

  const policy = evaluateShellExecutionPolicy(commandPreflight, {
    allow_real_execution: runAllEnabled,
    timeout_ms: options.timeout_ms || 180_000
  });

  if (!policy.ok && policy.reason !== 'real_shell_execution_not_enabled') {
    return {
      ok: false,
      reason: policy.reason,
      stage: 'shell_execution_policy',
      execution_preflight: executionPreflight,
      command_preflight: commandPreflight,
      policy,
      wired_to_runtime: false,
      execution_connected: false,
      run_all_enabled: runAllEnabled,
      plan_path: planPath
    };
  }

  return {
    ok: true,
    reason: runAllEnabled ? 'READY_FOR_TELEGRAM_EXECUTION_BUT_NOT_EXECUTED' : 'READY_BUT_NOT_EXECUTED',
    stage: 'ready_but_not_executed',
    execution_preflight: executionPreflight,
    command_preflight: commandPreflight,
    policy,
    command: 'scripts/gates/run-all.sh',
    args: [],
    cwd: '.',
    commands_executed: [],
    files_modified: [],
    wired_to_runtime: false,
    execution_connected: false,
    run_all_enabled: runAllEnabled,
    required_env: TELEGRAM_RUN_ALL_ENV,
    plan_path: planPath,
    next_action: runAllEnabled ? 'READY_FOR_TELEGRAM_EXECUTION_BUT_NOT_EXECUTED' : 'READY_BUT_NOT_EXECUTED'
  };
}

function runAllFromTelegram(approvalId, planPath, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const env = options.env || process.env;
  const runAllEnabled = telegramRunAllEnabled(env);

  if (!runAllEnabled) {
    return preflightRunAllFromTelegram(approvalId, planPath, options);
  }

  if (!approvalId) {
    return { ok: false, reason: 'approval_id_required', wired_to_runtime: false, execution_connected: false, run_all_enabled: false };
  }

  const planRead = readAllowedPlan(rootDir, planPath);
  if (!planRead.ok) {
    return { ...planRead, wired_to_runtime: false, execution_connected: false, run_all_enabled: true };
  }

  const result = runApprovedShellCommand(
    approvalId,
    planRead.plan,
    { command: 'scripts/gates/run-all.sh', args: [], cwd: '.' },
    {
      rootDir,
      current_diff_hash: options.current_diff_hash || EMPTY_DIFF_HASH,
      allow_real_execution: true,
      timeout_ms: options.timeout_ms || 180_000
    }
  );

  return {
    ...result,
    wired_to_runtime: true,
    execution_connected: true,
    run_all_enabled: true,
    plan_path: planPath
  };
}

module.exports = {
  EMPTY_DIFF_HASH,
  TELEGRAM_RUN_ALL_ENV,
  isAllowedTmpPlanPath,
  telegramRunAllEnabled,
  executeNoopFromTelegram,
  preflightRunAllFromTelegram,
  runAllFromTelegram
};
