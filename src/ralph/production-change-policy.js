const { APPROVAL_TYPES, CONTROL_ACTIONS, CONTROL_REASONS } = require('./types');
const { controlDecision } = require('./risk-evaluator');

const PRODUCTION_CHANGE_TYPES = Object.freeze({
  DB_MIGRATION: 'db_migration',
  DESTRUCTIVE_DB_CHANGE: 'destructive_db_change',
  RLS_POLICY: 'rls_policy',
  AUTH_LOGIC: 'auth_logic',
  SECRET_PERMISSION: 'secret_permission',
  DEPLOY: 'deploy'
});

const BLOCKED_SQL_PATTERNS = Object.freeze([
  /\bdrop\s+table\b/i,
  /\bdrop\s+column\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  /\balter\s+table\s+.*\bdisable\s+row\s+level\s+security\b/i,
  /\bdisable\s+row\s+level\s+security\b/i
]);

function planText(plan) {
  return JSON.stringify(plan || {});
}

function files(plan) {
  return [
    ...(Array.isArray(plan?.planned_files) ? plan.planned_files : []),
    ...(Array.isArray(plan?.files) ? plan.files : []),
    ...(Array.isArray(plan?.migration_files) ? plan.migration_files : []),
    ...(Array.isArray(plan?.migration_plan?.files) ? plan.migration_plan.files : [])
  ].map((file) => String(file || '').replace(/\\/g, '/'));
}

function targetEnv(plan) {
  return plan?.target_env || plan?.environment || 'local';
}

function hasMigration(plan) {
  return files(plan).some((file) => file.includes('supabase/migrations'));
}

function hasRlsChange(plan) {
  const text = planText(plan).toLowerCase();
  return text.includes('rls') || text.includes('row level security') || text.includes('policy');
}

function hasAuthChange(plan) {
  const text = planText(plan).toLowerCase();
  return text.includes('auth') || text.includes('authentication') || text.includes('authorization') || text.includes('jwt') || text.includes('session');
}

function hasSecretPermissionChange(plan) {
  const text = planText(plan).toLowerCase();
  return text.includes('service_role') || text.includes('secret permission') || text.includes('secret access') || text.includes('api key');
}

function hasDeploy(plan) {
  const text = planText(plan).toLowerCase();
  return text.includes('deploy') || plan?.deploy === true || plan?.deployment === true;
}

function hasBlockedSql(plan) {
  const text = planText(plan);
  return BLOCKED_SQL_PATTERNS.some((pattern) => pattern.test(text));
}

function classifyProductionChanges(plan) {
  const changes = [];
  if (hasMigration(plan)) changes.push(PRODUCTION_CHANGE_TYPES.DB_MIGRATION);
  if (hasBlockedSql(plan)) changes.push(PRODUCTION_CHANGE_TYPES.DESTRUCTIVE_DB_CHANGE);
  if (hasRlsChange(plan)) changes.push(PRODUCTION_CHANGE_TYPES.RLS_POLICY);
  if (hasAuthChange(plan)) changes.push(PRODUCTION_CHANGE_TYPES.AUTH_LOGIC);
  if (hasSecretPermissionChange(plan)) changes.push(PRODUCTION_CHANGE_TYPES.SECRET_PERMISSION);
  if (hasDeploy(plan)) changes.push(PRODUCTION_CHANGE_TYPES.DEPLOY);
  return Array.from(new Set(changes));
}

function decideProductionChangePolicy(plan = {}, { mode = 'approval', post_exec_diff_hash_changed = false } = {}) {
  const env = targetEnv(plan);
  const changes = classifyProductionChanges(plan);
  const production = env === 'production';
  const destructive = changes.includes(PRODUCTION_CHANGE_TYPES.DESTRUCTIVE_DB_CHANGE);

  if (destructive && production) {
    return {
      ok: false,
      stage: 'production_change_policy',
      reason: 'production_destructive_db_change_blocked',
      target_env: env,
      changes,
      decision: controlDecision(CONTROL_ACTIONS.STOP, CONTROL_REASONS.RISK_5_SECURITY_STOP, { mode, target_env: env, risk_score: 5, risk_category: 'production_destructive_db_change' }),
      plan_approval_required: false,
      diff_approval_required: false,
      production_db_change_allowed: false,
      rls_change_allowed: false,
      auth_change_allowed: false,
      deploy_allowed: false,
      migration_allowed: false,
      next_action: 'security_stop_until_human_resume_approval'
    };
  }

  const requiresPlanApproval = production && changes.some((change) => [
    PRODUCTION_CHANGE_TYPES.DB_MIGRATION,
    PRODUCTION_CHANGE_TYPES.RLS_POLICY,
    PRODUCTION_CHANGE_TYPES.AUTH_LOGIC,
    PRODUCTION_CHANGE_TYPES.SECRET_PERMISSION,
    PRODUCTION_CHANGE_TYPES.DEPLOY
  ].includes(change));
  const requiresDiffApproval = post_exec_diff_hash_changed || (production && changes.length > 0);

  if (requiresDiffApproval) {
    return allowedPolicy({
      env,
      changes,
      mode,
      decision: controlDecision(CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL, CONTROL_REASONS.DIFF_APPROVAL_REQUIRED, { mode, target_env: env, approval_type: APPROVAL_TYPES.DIFF, risk_score: production ? 4 : 3, risk_category: 'production_diff_review' }),
      plan_approval_required: requiresPlanApproval,
      diff_approval_required: true
    });
  }

  if (requiresPlanApproval) {
    return allowedPolicy({
      env,
      changes,
      mode,
      decision: controlDecision(CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, CONTROL_REASONS.PRODUCTION_RISK_REQUIRES_PLAN_APPROVAL, { mode, target_env: env, approval_type: APPROVAL_TYPES.PLAN, risk_score: 4, risk_category: 'production_change' }),
      plan_approval_required: true,
      diff_approval_required: false
    });
  }

  return allowedPolicy({
    env,
    changes,
    mode,
    decision: controlDecision(CONTROL_ACTIONS.AUTO_EXECUTE, CONTROL_REASONS.AUTO_EXECUTE_ALLOWED, { mode, target_env: env, risk_score: changes.length ? 3 : 0, risk_category: changes[0] || 'low' }),
    plan_approval_required: false,
    diff_approval_required: false
  });
}

function allowedPolicy({ env, changes, mode, decision, plan_approval_required, diff_approval_required }) {
  const production = env === 'production';
  return {
    ok: true,
    stage: 'production_change_policy',
    reason: null,
    target_env: env,
    changes,
    decision,
    plan_approval_required,
    diff_approval_required,
    production_db_change_allowed: production ? false : true,
    rls_change_allowed: production ? false : true,
    auth_change_allowed: production ? false : true,
    deploy_allowed: production ? false : true,
    migration_allowed: production ? false : true,
    requires_human: decision.requires_human,
    executable: decision.executable,
    next_action: decision.action === CONTROL_ACTIONS.AUTO_EXECUTE ? 'continue_with_non_production_change' : 'request_required_production_approval'
  };
}

module.exports = {
  PRODUCTION_CHANGE_TYPES,
  BLOCKED_SQL_PATTERNS,
  targetEnv,
  files,
  classifyProductionChanges,
  decideProductionChangePolicy,
  hasMigration,
  hasRlsChange,
  hasAuthChange,
  hasSecretPermissionChange,
  hasDeploy,
  hasBlockedSql
};
