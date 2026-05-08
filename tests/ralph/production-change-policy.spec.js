const { test, expect } = require('@playwright/test');
const { CONTROL_ACTIONS, APPROVAL_TYPES } = require('../../src/ralph/types');
const { PRODUCTION_CHANGE_TYPES, classifyProductionChanges, decideProductionChangePolicy } = require('../../src/ralph/production-change-policy');

test('classifyProductionChanges detects migration RLS auth secrets and deploy', () => {
  const changes = classifyProductionChanges({
    target_env: 'production',
    planned_files: ['supabase/migrations/001_policy.sql'],
    notes: 'Update RLS policy and auth session handling with service_role deploy'
  });
  expect(changes).toEqual(expect.arrayContaining([
    PRODUCTION_CHANGE_TYPES.DB_MIGRATION,
    PRODUCTION_CHANGE_TYPES.RLS_POLICY,
    PRODUCTION_CHANGE_TYPES.AUTH_LOGIC,
    PRODUCTION_CHANGE_TYPES.SECRET_PERMISSION,
    PRODUCTION_CHANGE_TYPES.DEPLOY
  ]));
});

test('production destructive DB change is security stop and never executable', () => {
  const result = decideProductionChangePolicy({ target_env: 'production', migration_plan: { files: ['supabase/migrations/001_drop.sql'], sql: 'DROP TABLE users;' } });
  expect(result).toMatchObject({
    ok: false,
    reason: 'production_destructive_db_change_blocked',
    target_env: 'production',
    plan_approval_required: false,
    diff_approval_required: false,
    production_db_change_allowed: false,
    rls_change_allowed: false,
    auth_change_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: 'security_stop_until_human_resume_approval'
  });
  expect(result.decision).toMatchObject({ action: CONTROL_ACTIONS.STOP, executable: false, requires_human: true });
});

test('production RLS auth migration requires diff approval and blocks automatic production effects', () => {
  const result = decideProductionChangePolicy({ target_env: 'production', planned_files: ['supabase/migrations/001_rls.sql'], description: 'RLS policy auth update' });
  expect(result).toMatchObject({
    ok: true,
    reason: null,
    target_env: 'production',
    plan_approval_required: true,
    diff_approval_required: true,
    production_db_change_allowed: false,
    rls_change_allowed: false,
    auth_change_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    requires_human: true,
    executable: false,
    next_action: 'request_required_production_approval'
  });
  expect(result.decision).toMatchObject({ action: CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL, approval_type: APPROVAL_TYPES.DIFF });
});

test('post exec diff hash change requires diff approval even outside production', () => {
  const result = decideProductionChangePolicy({ target_env: 'staging', planned_files: ['src/foo.js'] }, { post_exec_diff_hash_changed: true });
  expect(result).toMatchObject({ ok: true, diff_approval_required: true, requires_human: true, executable: false });
  expect(result.decision.action).toBe(CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL);
});

test('local non-production change can auto execute without production permissions', () => {
  const result = decideProductionChangePolicy({ target_env: 'local', planned_files: ['src/foo.js'] }, { mode: 'fullauto' });
  expect(result).toMatchObject({
    ok: true,
    plan_approval_required: false,
    diff_approval_required: false,
    production_db_change_allowed: true,
    rls_change_allowed: true,
    auth_change_allowed: true,
    deploy_allowed: true,
    migration_allowed: true,
    requires_human: false,
    executable: true,
    next_action: 'continue_with_non_production_change'
  });
  expect(result.decision.action).toBe(CONTROL_ACTIONS.AUTO_EXECUTE);
});
