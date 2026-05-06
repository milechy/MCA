const { test, expect } = require('@playwright/test');

const { COMMAND_ALLOWLIST } = require('../../src/ralph/command-allowlist');
const { TELEGRAM_RUN_ALL_ENV } = require('../../src/telegram/execution-adapter');
const {
  RUN_ALL_FAILURE_REASON_TAXONOMY,
  executionPolicyStatus,
  listExecutionCommands
} = require('../../src/telegram/policy-reader');
const {
  RUN_ALL_FAILURE_REASON_TAXONOMY: SHARED_RUN_ALL_FAILURE_REASON_TAXONOMY,
  RUN_ALL_FAILURE_REASON_NORMALIZATION,
  RUN_ALL_FAILURE_AUDIT_SUMMARY_FIELDS
} = require('../../src/telegram/run-all-taxonomy');

function expectedAllowedCommandsFromAllowlist() {
  return COMMAND_ALLOWLIST.map((entry) => ({
    id: entry.id,
    command: entry.command,
    allowed_args: entry.allowed_args || [],
    allowed_cwd: entry.allowed_cwd || '.',
    phase: entry.phase,
    dry_run_only: entry.dry_run_only === true
  }));
}

test('listExecutionCommands mirrors COMMAND_ALLOWLIST', () => {
  expect(listExecutionCommands()).toEqual(expectedAllowedCommandsFromAllowlist());
  expect(listExecutionCommands()).toHaveLength(COMMAND_ALLOWLIST.length);
});

test('executionPolicyStatus exposes allowed commands from COMMAND_ALLOWLIST', () => {
  const policy = executionPolicyStatus({});

  expect(policy.allowed_commands).toEqual(expectedAllowedCommandsFromAllowlist());
  expect(policy.allowed_commands).toHaveLength(COMMAND_ALLOWLIST.length);
});

test('executionPolicyStatus reports Telegram run-all env gate off by default', () => {
  const policy = executionPolicyStatus({});

  expect(policy.execution_connected).toBe(true);
  expect(policy.telegram_shell_execution_connected).toBe(false);
  expect(policy.telegram_run_all_env).toBe(TELEGRAM_RUN_ALL_ENV);
  expect(policy.telegram_run_all_enabled).toBe(false);
  expect(policy.telegram_run_all_default_off).toBe(true);
  expect(policy.telegram_run_all_required_value).toBe('true');
  expect(policy.run_all_execution_conditions).toContain(`${TELEGRAM_RUN_ALL_ENV}=true`);
});

test('executionPolicyStatus reports Telegram run-all env gate true only for explicit true string', () => {
  expect(executionPolicyStatus({ [TELEGRAM_RUN_ALL_ENV]: 'true' }).telegram_shell_execution_connected).toBe(true);
  expect(executionPolicyStatus({ [TELEGRAM_RUN_ALL_ENV]: 'true' }).telegram_run_all_enabled).toBe(true);
  expect(executionPolicyStatus({ [TELEGRAM_RUN_ALL_ENV]: '1' }).telegram_run_all_enabled).toBe(false);
  expect(executionPolicyStatus({ [TELEGRAM_RUN_ALL_ENV]: 'TRUE' }).telegram_run_all_enabled).toBe(false);
});

test('executionPolicyStatus exposes shared run-all failure taxonomy fields', () => {
  const policy = executionPolicyStatus({});

  expect(RUN_ALL_FAILURE_REASON_TAXONOMY).toEqual(SHARED_RUN_ALL_FAILURE_REASON_TAXONOMY);
  expect(policy.run_all_failure_reason_taxonomy).toEqual(SHARED_RUN_ALL_FAILURE_REASON_TAXONOMY);
  expect(policy.run_all_failure_reason_normalization).toEqual(RUN_ALL_FAILURE_REASON_NORMALIZATION);
  expect(policy.run_all_failure_audit_summary_fields).toEqual(RUN_ALL_FAILURE_AUDIT_SUMMARY_FIELDS);
});

test('executionPolicyStatus exposes fixed execution safety flags', () => {
  const policy = executionPolicyStatus({});

  expect(policy.allow_real_execution_required).toBe(true);
  expect(policy.approval_preflight_required).toBe(true);
  expect(policy.plan_hash_verification_required).toBe(true);
  expect(policy.diff_hash_verification_required).toBe(true);
  expect(policy.production_target_blocked).toBe(true);
  expect(policy.unsupported_from_telegram).toEqual([
    'OpenCode execution',
    'migration execution',
    'deploy execution',
    'production secrets'
  ]);
});
