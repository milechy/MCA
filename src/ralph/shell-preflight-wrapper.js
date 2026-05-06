const { verifyExecutionPreflight } = require('./execution-preflight');
const { validateCommandRequest } = require('./command-allowlist');
const { dryRunShellCommand } = require('./shell-dry-run');
const { appendExecutionLog } = require('./execution-log');

function verifyShellDryRunPreflight(approvalId, plan, commandRequest, options = {}) {
  const rootDir = options.rootDir || process.cwd();

  const executionPreflight = verifyExecutionPreflight(approvalId, plan, {
    rootDir,
    current_diff_hash: options.current_diff_hash,
    mode: options.mode
  });

  if (!executionPreflight.ok) {
    return {
      ok: false,
      reason: executionPreflight.reason,
      stage: 'execution_preflight',
      execution_preflight: executionPreflight
    };
  }

  const commandPreflight = validateCommandRequest(commandRequest, { dry_run_only: true });
  if (!commandPreflight.ok) {
    return {
      ok: false,
      reason: commandPreflight.reason,
      stage: 'command_allowlist',
      execution_preflight: executionPreflight,
      command_preflight: commandPreflight
    };
  }

  return {
    ok: true,
    execution_preflight: executionPreflight,
    command_preflight: commandPreflight,
    execution_connected: false,
    next_action: 'SHELL_DRY_RUN_ALLOWED_BY_PREFLIGHT_ONLY'
  };
}

function runShellDryRunWithPreflight(approvalId, plan, commandRequest, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const preflight = verifyShellDryRunPreflight(approvalId, plan, commandRequest, options);

  if (!preflight.ok) {
    const log = appendExecutionLog({
      event: 'shell_dry_run_preflight_failed',
      approval_id: approvalId,
      reason: preflight.reason,
      stage: preflight.stage,
      preflight
    }, { rootDir });

    return {
      ok: false,
      reason: preflight.reason,
      stage: preflight.stage,
      preflight,
      log
    };
  }

  const result = dryRunShellCommand(commandRequest, { rootDir });
  const log = appendExecutionLog({
    event: 'shell_dry_run_with_preflight_completed',
    approval_id: approvalId,
    command_hash: preflight.command_preflight.command_hash,
    preflight,
    result
  }, { rootDir });

  return {
    ok: result.ok,
    reason: result.reason,
    approval_id: approvalId,
    preflight,
    shell_dry_run: result,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    log
  };
}

module.exports = {
  verifyShellDryRunPreflight,
  runShellDryRunWithPreflight
};
