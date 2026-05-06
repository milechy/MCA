const { appendExecutionLog } = require('./execution-log');
const { validateCommandRequest } = require('./command-allowlist');

function dryRunShellCommand(commandRequest, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const validation = validateCommandRequest(commandRequest, { dry_run_only: true });

  if (!validation.ok) {
    const log = appendExecutionLog({
      event: 'shell_command_rejected',
      reason: validation.reason,
      validation
    }, { rootDir });

    return {
      ok: false,
      reason: validation.reason,
      validation,
      log
    };
  }

  const result = {
    ok: true,
    executor: 'shell-dry-run',
    command: validation.request.command,
    args: validation.request.args,
    cwd: validation.request.cwd,
    command_hash: validation.command_hash,
    dry_run_only: true,
    commands_executed: [],
    files_modified: [],
    message: 'Shell command dry-run validated. No command was executed.'
  };

  const log = appendExecutionLog({
    event: 'shell_command_dry_run_validated',
    command_hash: validation.command_hash,
    request: validation.request,
    allowlist_entry: validation.allowlist_entry,
    result
  }, { rootDir });

  return {
    ...result,
    log
  };
}

module.exports = {
  dryRunShellCommand
};
