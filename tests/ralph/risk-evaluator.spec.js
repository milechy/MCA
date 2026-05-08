const { test, expect } = require('@playwright/test');
const { CONTROL_ACTIONS, APPROVAL_TYPES, CONTROL_REASONS } = require('../../src/ralph/types');
const { evaluateRisk, decideControlAction } = require('../../src/ralph/risk-evaluator');

test('destructive SQL produces Risk 5 stop decision', () => {
  const plan = {
    story_id: 'STORY-SECURITY',
    migration_plan: {
      files: ['supabase/migrations/001_drop.sql'],
      sql: 'DROP TABLE users;'
    }
  };

  const risk = evaluateRisk(plan);
  const decision = decideControlAction(risk, 'fullauto', 'production');

  expect(risk.score).toBe(5);
  expect(decision).toMatchObject({
    action: CONTROL_ACTIONS.STOP,
    reason: CONTROL_REASONS.RISK_5_SECURITY_STOP,
    requires_human: true,
    executable: false
  });
});

test('staging migration requires approval in approval mode', () => {
  const plan = {
    story_id: 'STORY-DB',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_add_profile.sql']
  };

  const risk = evaluateRisk(plan);
  const decision = decideControlAction(risk, 'approval', 'staging');

  expect(risk).toMatchObject({ score: 3, category: 'local_or_staging_db_migration', label: 'RISK_3A_DB_MIGRATION', control_model: 'control_decision_v1' });
  expect(decision).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL,
    reason: CONTROL_REASONS.APPROVAL_MODE_RISK_THRESHOLD,
    approval_type: APPROVAL_TYPES.PLAN,
    target_env: 'staging',
    risk_score: 3,
    requires_human: true,
    executable: false
  });
});

test('production risk requires plan approval even outside approval mode threshold', () => {
  const risk = { score: 3, category: 'rls_policy_change', label: 'RISK_3C_RLS_POLICY' };
  const decision = decideControlAction(risk, { mode: 'fullauto', target_env: 'production' });
  expect(decision).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL,
    reason: CONTROL_REASONS.PRODUCTION_RISK_REQUIRES_PLAN_APPROVAL,
    approval_type: APPROVAL_TYPES.PLAN
  });
});

test('diff approval is explicit and never confused with auto execute', () => {
  const risk = { score: 0, category: 'low', label: 'RISK_0_LOW' };
  const decision = decideControlAction(risk, { mode: 'fullauto', target_env: 'local', approval_type: APPROVAL_TYPES.DIFF });
  expect(decision).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL,
    reason: CONTROL_REASONS.DIFF_APPROVAL_REQUIRED,
    approval_type: APPROVAL_TYPES.DIFF,
    requires_human: true,
    executable: false
  });
});

test('mode change and resume after security stop require approval', () => {
  const risk = { score: 0, category: 'low', label: 'RISK_0_LOW' };
  expect(decideControlAction(risk, { mode_change: true })).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL,
    reason: CONTROL_REASONS.MODE_CHANGE_REQUIRES_PLAN_APPROVAL,
    approval_type: APPROVAL_TYPES.MODE_CHANGE
  });
  expect(decideControlAction(risk, { resume_after_security_stop: true })).toMatchObject({
    action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL,
    reason: CONTROL_REASONS.RESUME_AFTER_SECURITY_STOP_REQUIRES_PLAN_APPROVAL,
    approval_type: APPROVAL_TYPES.RESUME_AFTER_SECURITY_STOP
  });
});

test('low risk fullauto can auto execute with explicit decision object', () => {
  const risk = { score: 1, category: 'low', label: 'RISK_1_LOW' };
  expect(decideControlAction(risk, { mode: 'fullauto', target_env: 'local' })).toMatchObject({
    action: CONTROL_ACTIONS.AUTO_EXECUTE,
    reason: CONTROL_REASONS.AUTO_EXECUTE_ALLOWED,
    requires_human: false,
    executable: true
  });
});
