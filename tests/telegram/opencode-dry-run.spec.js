const { test, expect } = require('@playwright/test');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const {
  DEFAULT_ALLOWED_PATHS,
  DEFAULT_FORBIDDEN_PATHS,
  classifyIntent,
  makeOpenCodeDryRunPlan,
  summarizeOpenCodeDryRunPlan
} = require('../../src/telegram/opencode-dry-run');

test('parseTelegramCommand parses /opencode-plan as dry-run planning command', () => {
  const parsed = parseTelegramCommand('/opencode-plan add tests for telegram policy');

  expect(parsed.type).toBe('opencode_plan');
  expect(parsed.args).toEqual(['add', 'tests', 'for', 'telegram', 'policy']);
});

test('OpenCode dry-run plan returns metadata only and never connects execution', () => {
  const plan = makeOpenCodeDryRunPlan('add a drift test for Phase 11 docs');
  const summary = summarizeOpenCodeDryRunPlan(plan);

  expect(summary).toMatchObject({
    ok: true,
    stage: 'opencode_dry_run_plan',
    reason: null,
    requires_approval: true,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    next_action: 'review_plan_then_replan_for_phase12_sandbox'
  });
  expect(summary.risk.label).toBe('READ_ONLY_PLANNING_APPROVAL_REQUIRED_BEFORE_APPLY');
  expect(summary.allowed_paths).toEqual([...DEFAULT_ALLOWED_PATHS]);
  expect(summary.forbidden_paths).toEqual([...DEFAULT_FORBIDDEN_PATHS]);
  expect(summary.diff_preview).toEqual({ available: false, reason: 'phase11_metadata_only' });
});

test('OpenCode dry-run plan blocks deployment migration secret and remote shell intents', () => {
  for (const [intent, reason] of [
    ['deploy this to production', 'production_deploy_requested'],
    ['run db migration for users table', 'migration_requested'],
    ['rotate the API token', 'secret_handling_requested'],
    ['ssh into the server and fix it', 'remote_shell_requested']
  ]) {
    const classification = classifyIntent(intent);
    const plan = makeOpenCodeDryRunPlan(intent);
    expect(classification.ok).toBe(false);
    expect(classification.reason).toBe(reason);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe(reason);
    expect(plan.execution_connected).toBe(false);
    expect(plan.commands_executed).toEqual([]);
    expect(plan.files_modified).toEqual([]);
    expect(plan.diff_preview).toEqual({ available: false, reason: 'blocked_intent' });
  }
});

test('/opencode-plan handler is bounded metadata only and execution disconnected', () => {
  const result = handleTelegramCommand(parseTelegramCommand('/opencode-plan add tests for smoke validator'), {
    rootDir: process.cwd(),
    user_id: 3,
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.execution_connected).toBe(false);
  expect(result.summary.commands_executed).toEqual([]);
  expect(result.summary.files_modified).toEqual([]);
  expect(result.text).toContain('OpenCode dry-run plan ready. Execution remains disconnected.');
  expect(result.text).not.toContain('stdout');
  expect(result.text).not.toContain('stderr');
  expect(result.text).not.toContain('raw');
});

test('/opencode-plan handler blocks forbidden intents without execution', () => {
  const result = handleTelegramCommand(parseTelegramCommand('/opencode-plan deploy to production'), {
    rootDir: process.cwd(),
    user_id: 3,
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.summary.ok).toBe(false);
  expect(result.summary.reason).toBe('production_deploy_requested');
  expect(result.summary.commands_executed).toEqual([]);
  expect(result.summary.files_modified).toEqual([]);
  expect(result.text).toContain('OpenCode dry-run plan blocked: production_deploy_requested');
});
