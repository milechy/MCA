const { verifyExecutionPreflight } = require('./execution-preflight');
const { validateCommandRequest } = require('./command-allowlist');
const { evaluateShellExecutionPolicy } = require('./shell-execution-policy');
const { executeShellCommand } = require('./shell-executor');
const { appendExecutionLog } = require('./execution-log');

function runApprovedShellCommand(approvalId, plan, commandRequest, options = {}) {
  const rootDir = options.rootDir || process.cwd();

  const executionPreflight = verifyExecutionPreflight(approvalId, plan, {
    rootDir,
    current_diff_hash: options.current_diff_hash,
    mode: options.mode
  });

  if (!executionPreflight.ok) {
    const log = appendExecutionLog({
      event: 'approved_shell_execution_blocked',
      approval_id: approvalId,
      reason: executionPreflight.reason,
      stage: 'execution_preflight',
      execution_preflight: executionPreflight
    }, { rootDir });

    return {
      ok: false,
      reason: executionPreflight.reason,
      stage: 'execution_preflight',
      execution_connected: false,
      commands_executed: [],
      files_modified: [],
      execution_preflight: executionPreflight,
      log
    };
  }

  const commandPreflight = validateCommandRequest(commandRequest, { allowlist: options.allowlist });
  if (!commandPreflight.ok) {
    const log = appendExecutionLog({
      event: 'approved_shell_execution_blocked',
      approval_id: approvalId,
      reason: commandPreflight.reason,
      stage: 'command_allowlist',
      execution_preflight: executionPreflight,
      command_preflight: commandPreflight
    }, { rootDir });

    return {
      ok: false,
      reason: commandPreflight.reason,
      stage: 'command_allowlist',
      execution_connected: false,
      commands_executed: [],
      files_modified: [],
      execution_preflight: executionPreflight,
      command_preflight: commandPreflight,
      log
    };
  }

  const policy = evaluateShellExecutionPolicy(commandPreflight, {
    allow_real_execution: options.allow_real_execution === true,
    timeout_ms: options.timeout_ms
  });

  if (!policy.ok) {
    const log = appendExecutionLog({
      event: 'approved_shell_execution_blocked',
      approval_id: approvalId,
      reason: policy.reason,
      stage: 'shell_execution_policy',
      execution_preflight: executionPreflight,
      command_preflight: commandPreflight,
      policy
    }, { rootDir });

    return {
      ok: false,
      reason: policy.reason,
      stage: 'shell_execution_policy',
      execution_connected: false,
      commands_executed: [],
      files_modified: [],
      execution_preflight: executionPreflight,
      command_preflight: commandPreflight,
      policy,
      log
    };
  }

  const result = executeShellCommand(commandRequest, {
    rootDir,
    allow_real_execution: true,
    timeout_ms: policy.timeout_ms,
    allowlist: options.allowlist
  });

  const log = appendExecutionLog({
    event: result.ok ? 'approved_shell_execution_completed' : 'approved_shell_execution_failed',
    approval_id: approvalId,
    command_hash: commandPreflight.command_hash,
    execution_preflight: executionPreflight,
    command_preflight: commandPreflight,
    policy,
    result
  }, { rootDir });

  return {
    ...result,
    approval_id: approvalId,
    execution_preflight: executionPreflight,
    command_preflight: commandPreflight,
    policy,
    log
  };
}

module.exports = {
  runApprovedShellCommand
};
