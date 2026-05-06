const { test, expect } = require('@playwright/test');
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
  expect(decision.action).toBe('stop');
});

test('staging migration requires approval in approval mode', () => {
  const plan = {
    story_id: 'STORY-DB',
    target_env: 'staging',
    planned_files: ['supabase/migrations/001_add_profile.sql']
  };

  const risk = evaluateRisk(plan);
  const decision = decideControlAction(risk, 'approval', 'staging');

  expect(risk.score).toBe(3);
  expect(decision.action).toBe('require_plan_approval');
});
