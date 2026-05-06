const { test, expect } = require('@playwright/test');

const {
  RUN_ALL_FAILURE_REASON_TAXONOMY,
  RUN_ALL_FAILURE_REASON_NORMALIZATION,
  RUN_ALL_FAILURE_AUDIT_SUMMARY_FIELDS,
  normalizeRunAllReason
} = require('../../src/telegram/run-all-taxonomy');

test('run-all failure reason taxonomy is the single source of truth', () => {
  expect(RUN_ALL_FAILURE_REASON_TAXONOMY).toEqual([
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
});

test('run-all failure reason normalization is fixed', () => {
  expect(RUN_ALL_FAILURE_REASON_NORMALIZATION).toEqual({
    plan_file_not_found: 'plan_file_missing',
    command_not_allowed: 'command_not_allowlisted'
  });

  expect(normalizeRunAllReason('plan_file_not_found')).toBe('plan_file_missing');
  expect(normalizeRunAllReason('command_not_allowed')).toBe('command_not_allowlisted');
  expect(normalizeRunAllReason('approval_not_found')).toBe('approval_not_found');
  expect(normalizeRunAllReason('shell_execution_failed')).toBe('shell_execution_failed');
  expect(normalizeRunAllReason(null)).toBe(null);
  expect(normalizeRunAllReason(undefined)).toBe(null);
  expect(normalizeRunAllReason('')).toBe(null);
});

test('run-all failure audit summary fields are fixed', () => {
  expect(RUN_ALL_FAILURE_AUDIT_SUMMARY_FIELDS).toEqual([
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
});

test('run-all taxonomy constants are frozen', () => {
  expect(Object.isFrozen(RUN_ALL_FAILURE_REASON_TAXONOMY)).toBe(true);
  expect(Object.isFrozen(RUN_ALL_FAILURE_REASON_NORMALIZATION)).toBe(true);
  expect(Object.isFrozen(RUN_ALL_FAILURE_AUDIT_SUMMARY_FIELDS)).toBe(true);
});
