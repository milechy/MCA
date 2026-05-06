const { COMMAND_ALLOWLIST } = require('../ralph/command-allowlist');

function listExecutionCommands() {
  return COMMAND_ALLOWLIST.map((entry) => ({
    id: entry.id,
    command: entry.command,
    allowed_args: entry.allowed_args || [],
    allowed_cwd: entry.allowed_cwd || '.',
    phase: entry.phase,
    dry_run_only: entry.dry_run_only === true
  }));
}

function executionPolicyStatus() {
  return {
    execution_connected: true,
    telegram_shell_execution_connected: false,
    allow_real_execution_required: true,
    approval_preflight_required: true,
    plan_hash_verification_required: true,
    diff_hash_verification_required: true,
    production_target_blocked: true,
    allowed_commands: listExecutionCommands(),
    unsupported_from_telegram: [
      'shell execution',
      'OpenCode execution',
      'migration execution',
      'deploy execution',
      'production secrets'
    ]
  };
}

module.exports = {
  executionPolicyStatus,
  listExecutionCommands
};
