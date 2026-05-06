const { COMMAND_ALLOWLIST } = require('../ralph/command-allowlist');
const { TELEGRAM_RUN_ALL_ENV, telegramRunAllEnabled } = require('./execution-adapter');
const { RUN_ALL_FAILURE_REASON_TAXONOMY } = require('./handlers');

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

function executionPolicyStatus(env = process.env) {
  const telegramRunAllEnabledNow = telegramRunAllEnabled(env);

  return {
    execution_connected: true,
    telegram_shell_execution_connected: telegramRunAllEnabledNow,
    telegram_run_all_env: TELEGRAM_RUN_ALL_ENV,
    telegram_run_all_enabled: telegramRunAllEnabledNow,
    telegram_run_all_default_off: true,
    telegram_run_all_required_value: 'true',
    allow_real_execution_required: true,
    approval_preflight_required: true,
    plan_hash_verification_required: true,
    diff_hash_verification_required: true,
    production_target_blocked: true,
    run_all_execution_conditions: [
      'authorized_telegram_user_and_chat',
      'approved_approval',
      'plan_hash_match',
      'diff_hash_match',
      'command_allowlist_match',
      'shell_execution_policy_pass',
      `${TELEGRAM_RUN_ALL_ENV}=true`
    ],
    run_all_failure_reason_taxonomy: RUN_ALL_FAILURE_REASON_TAXONOMY,
    run_all_failure_reason_normalization: {
      plan_file_not_found: 'plan_file_missing',
      command_not_allowed: 'command_not_allowlisted'
    },
    run_all_failure_audit_summary_fields: [
      'ok',
      'reason',
      'reason_taxonomy',
      'stage',
      'executor',
      'command',
      'exit_code',
      'started_at',
      'finished_at',
      'duration_ms',
      'run_all_enabled',
      'wired_to_runtime',
      'execution_connected',
      'commands_executed',
      'files_modified',
      'approval_id',
      'plan_path',
      'log_path'
    ],
    allowed_commands: listExecutionCommands(),
    unsupported_from_telegram: [
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
