const { execFileSync } = require('node:child_process');
const { validateCommandRequest } = require('./command-allowlist');
const { appendExecutionLog } = require('./execution-log');

function block(reason, details = {}, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const log = appendExecutionLog({
    event: 'shell_execution_blocked',
    reason,
    details
  }, { rootDir });

  return {
    ok: false,
    reason,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    log,
    ...details
  };
}

function executeShellCommand(commandRequest, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const allowRealExecution = options.allow_real_execution === true;
  const timeoutMs = options.timeout_ms || 120_000;

  const validation = validateCommandRequest(commandRequest);
  if (!validation.ok) {
    return block(validation.reason, { validation }, { rootDir });
  }

  if (validation.allowlist_entry.dry_run_only === true) {
    return block('allowlist_entry_is_dry_run_only', { validation }, { rootDir });
  }

  if (!allowRealExecution) {
    return block('real_shell_execution_not_enabled', { validation }, { rootDir });
  }

  const startedAt = new Date().toISOString();
  try {
    const stdout = execFileSync(validation.request.command, validation.request.args, {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const result = {
      ok: true,
      executor: 'shell',
      command: validation.request.command,
      args: validation.request.args,
      cwd: validation.request.cwd,
      command_hash: validation.command_hash,
      timeout_ms: timeoutMs,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: 0,
      stdout,
      stderr: '',
      commands_executed: [validation.request.command],
      files_modified: []
    };

    const log = appendExecutionLog({
      event: 'shell_execution_completed',
      command_hash: validation.command_hash,
      result
    }, { rootDir });

    return { ...result, log };
  } catch (error) {
    const result = {
      ok: false,
      reason: 'shell_execution_failed',
      executor: 'shell',
      command: validation.request.command,
      args: validation.request.args,
      cwd: validation.request.cwd,
      command_hash: validation.command_hash,
      timeout_ms: timeoutMs,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: typeof error.status === 'number' ? error.status : null,
      stdout: error.stdout ? String(error.stdout) : '',
      stderr: error.stderr ? String(error.stderr) : String(error.message || ''),
      commands_executed: [validation.request.command],
      files_modified: []
    };

    const log = appendExecutionLog({
      event: 'shell_execution_failed',
      command_hash: validation.command_hash,
      result
    }, { rootDir });

    return { ...result, log };
  }
}

module.exports = {
  executeShellCommand
};
