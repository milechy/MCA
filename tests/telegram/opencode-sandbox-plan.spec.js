const { test, expect } = require('@playwright/test');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const {
  sanitizeApprovalId,
  makeSandboxRoot,
  isAllowedSandboxRoot,
  makeSandboxBranch,
  makeOpenCodeSandboxPlan,
  summarizeOpenCodeSandboxPlan
} = require('../../src/telegram/opencode-sandbox-plan');

test('parseTelegramCommand parses /opencode-sandbox-plan as metadata-only sandbox command', () => {
  const parsed = parseTelegramCommand('/opencode-sandbox-plan APR-TEST add validator tests');

  expect(parsed.type).toBe('opencode_sandbox_plan');
  expect(parsed.args).toEqual(['APR-TEST', 'add', 'validator', 'tests']);
});

test('sandbox approval id and root validation are strict', () => {
  expect(sanitizeApprovalId('APR-TELEGRAM-SANDBOX-1')).toBe('APR-TELEGRAM-SANDBOX-1');
  expect(sanitizeApprovalId('../APR-BAD')).toBe(null);
  expect(sanitizeApprovalId('')).toBe(null);

  expect(makeSandboxRoot('APR-TELEGRAM-SANDBOX-1')).toBe('.ralph/tmp/opencode-sandbox/APR-TELEGRAM-SANDBOX-1');
  expect(makeSandboxBranch('APR-TELEGRAM-SANDBOX-1')).toBe('opencode-sandbox/apr-telegram-sandbox-1');

  expect(isAllowedSandboxRoot('.ralph/tmp/opencode-sandbox/APR-TELEGRAM-SANDBOX-1')).toBe(true);
  expect(isAllowedSandboxRoot('/tmp/opencode-sandbox/APR-TELEGRAM-SANDBOX-1')).toBe(false);
  expect(isAllowedSandboxRoot('.ralph/tmp/opencode-sandbox/APR-../evil')).toBe(false);
  expect(isAllowedSandboxRoot('.ralph/logs/APR-TELEGRAM-SANDBOX-1')).toBe(false);
});

test('OpenCode sandbox plan returns bounded metadata and keeps execution disabled', () => {
  const plan = makeOpenCodeSandboxPlan({
    approval_id: 'APR-TELEGRAM-SANDBOX-1',
    intent: 'add tests for opencode sandbox planner'
  });
  const summary = summarizeOpenCodeSandboxPlan(plan);

  expect(summary).toMatchObject({
    ok: true,
    stage: 'opencode_sandbox_plan',
    reason: null,
    approval_id: 'APR-TELEGRAM-SANDBOX-1',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-TELEGRAM-SANDBOX-1',
    sandbox_branch: 'opencode-sandbox/apr-telegram-sandbox-1',
    requires_approval: true,
    execution_connected: false,
    opencode_execution_enabled: false,
    commands_executed: [],
    files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'review_sandbox_plan_then_request_phase12_execution_approval'
  });
  expect(summary.risk.label).toBe('SANDBOX_METADATA_ONLY_APPROVAL_REQUIRED_BEFORE_EXECUTION');
});

test('OpenCode sandbox plan blocks missing approval and forbidden intents without execution', () => {
  const missingApproval = makeOpenCodeSandboxPlan({ intent: 'add tests' });
  expect(missingApproval.ok).toBe(false);
  expect(missingApproval.reason).toBe('approval_id_invalid');
  expect(missingApproval.execution_connected).toBe(false);
  expect(missingApproval.opencode_execution_enabled).toBe(false);
  expect(missingApproval.commands_executed).toEqual([]);
  expect(missingApproval.files_modified).toEqual([]);

  const blocked = makeOpenCodeSandboxPlan({ approval_id: 'APR-TELEGRAM-SANDBOX-1', intent: 'deploy this to production' });
  expect(blocked.ok).toBe(false);
  expect(blocked.reason).toBe('production_deploy_requested');
  expect(blocked.execution_connected).toBe(false);
  expect(blocked.opencode_execution_enabled).toBe(false);
  expect(blocked.commands_executed).toEqual([]);
  expect(blocked.files_modified).toEqual([]);
});

test('/opencode-sandbox-plan handler returns metadata only and never enables execution', () => {
  const result = handleTelegramCommand(parseTelegramCommand('/opencode-sandbox-plan APR-TELEGRAM-SANDBOX-1 add sandbox tests'), {
    rootDir: process.cwd(),
    user_id: 3,
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.opencode_execution_enabled).toBe(false);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.execution_connected).toBe(false);
  expect(result.summary.opencode_execution_enabled).toBe(false);
  expect(result.summary.commands_executed).toEqual([]);
  expect(result.summary.files_modified).toEqual([]);
  expect(result.summary.commit_created).toBe(false);
  expect(result.summary.push_performed).toBe(false);
  expect(result.summary.deploy_performed).toBe(false);
  expect(result.summary.migration_performed).toBe(false);
  expect(result.text).toContain('OpenCode sandbox plan ready. OpenCode execution remains disabled.');
});
