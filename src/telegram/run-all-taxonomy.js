const RUN_ALL_FAILURE_REASON_TAXONOMY = Object.freeze([
  'approval_id_required',
  'plan_path_not_allowed',
  'plan_file_missing',
  'approval_not_found',
  'approval_not_approved',
  'plan_hash_mismatch',
  'diff_hash_mismatch',
  'command_not_allowlisted',
  'allowlist_entry_is_dry_run_only',
  'real_shell_execution_not_enabled',
  'shell_execution_failed'
]);

const RUN_ALL_FAILURE_REASON_NORMALIZATION = Object.freeze({
  plan_file_not_found: 'plan_file_missing',
  command_not_allowed: 'command_not_allowlisted'
});

const RUN_ALL_FAILURE_AUDIT_SUMMARY_FIELDS = Object.freeze([
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
]);

function normalizeRunAllReason(reason) {
  if (!reason) return null;
  return RUN_ALL_FAILURE_REASON_NORMALIZATION[reason] || reason;
}

module.exports = {
  RUN_ALL_FAILURE_REASON_TAXONOMY,
  RUN_ALL_FAILURE_REASON_NORMALIZATION,
  RUN_ALL_FAILURE_AUDIT_SUMMARY_FIELDS,
  normalizeRunAllReason
};
