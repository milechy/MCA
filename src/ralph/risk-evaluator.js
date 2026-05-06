const { CONTROL_ACTIONS } = require('./types');

function maxRisk(a, b) {
  return b.score > a.score ? b : a;
}

function createRisk(score, category, label) {
  return { score, category, label };
}

function planText(plan) {
  return JSON.stringify(plan || {}).toLowerCase();
}

function hasDbMigration(plan) {
  const migrations = plan?.migration_plan?.files || plan?.migration_files || [];
  const files = plan?.planned_files || [];
  return migrations.length > 0 || files.some((file) => file.includes('supabase/migrations'));
}

function targetEnv(plan) {
  return plan?.target_env || plan?.environment || 'local';
}

function isProduction(plan) {
  return targetEnv(plan) === 'production';
}

function touchesAuthOrRls(plan) {
  const text = planText(plan);
  return text.includes('rls') || text.includes('row level security') || text.includes('auth') || text.includes('policy');
}

function touchesExternalApi(plan) {
  const text = planText(plan);
  return text.includes('external api') || text.includes('webhook') || text.includes('third-party') || text.includes('third party');
}

function isDestructive(plan) {
  const text = planText(plan);
  const destructivePatterns = [
    'drop table',
    'drop column',
    'truncate',
    'delete from',
    'disable row level security',
    'alter table disable row level security',
    'service_role',
    'secret exposure'
  ];
  return destructivePatterns.some((pattern) => text.includes(pattern));
}

function evaluateRisk(plan) {
  let risk = createRisk(0, 'low', 'RISK_0_LOW');

  if (hasDbMigration(plan)) {
    risk = maxRisk(
      risk,
      isProduction(plan)
        ? createRisk(4, 'production_db_migration', 'RISK_4_PRODUCTION_DB')
        : createRisk(3, 'staging_or_local_db_migration', 'RISK_3_DB_MIGRATION')
    );
  }

  if (touchesAuthOrRls(plan)) {
    risk = maxRisk(risk, createRisk(3, 'auth_or_rls', 'RISK_3_AUTH_RLS'));
  }

  if (touchesExternalApi(plan)) {
    risk = maxRisk(risk, createRisk(3, 'external_api', 'RISK_3_EXTERNAL_API'));
  }

  if (isDestructive(plan)) {
    risk = createRisk(5, 'destructive_or_secret_risk', 'RISK_5_DESTRUCTIVE_OR_SECRET');
  }

  return {
    ...risk,
    requires_approval: risk.score >= 2
  };
}

function decideControlAction(risk, mode = 'approval', env = 'local', approvalType = 'plan') {
  if (risk.score >= 5) {
    return { action: CONTROL_ACTIONS.STOP, reason: 'risk_5_requires_security_stop' };
  }

  if (approvalType === 'diff') {
    return { action: CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL, reason: 'diff_approval_required' };
  }

  if (env === 'production' && risk.score >= 3) {
    return { action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, reason: 'production_risk_requires_approval' };
  }

  if (mode === 'approval' && risk.score >= 2) {
    return { action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, reason: 'approval_mode_risk_threshold' };
  }

  if (mode === 'fullauto' && risk.score >= 4) {
    return { action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, reason: 'fullauto_high_risk_threshold' };
  }

  return { action: CONTROL_ACTIONS.AUTO_EXECUTE, reason: 'risk_within_auto_execute_policy' };
}

module.exports = {
  createRisk,
  evaluateRisk,
  decideControlAction,
  targetEnv,
  hasDbMigration,
  touchesAuthOrRls,
  touchesExternalApi,
  isDestructive
};
