const { CONTROL_ACTIONS, CONTROL_REASONS, APPROVAL_TYPES } = require('./types');
const { riskForPaths, pathsFromPlan } = require('./risk-paths');

function maxRisk(a, b) {
  return b.score > a.score ? b : a;
}

function createRisk(score, category, label, details = {}) {
  return { score, category, label, ...details };
}

function controlDecision(action, reason, details = {}) {
  return {
    action,
    reason,
    approval_type: details.approval_type || null,
    target_phase: details.target_phase || null,
    mode: details.mode || null,
    target_env: details.target_env || null,
    risk_score: Number.isInteger(details.risk_score) ? details.risk_score : null,
    risk_category: details.risk_category || null,
    requires_human: action !== CONTROL_ACTIONS.AUTO_EXECUTE,
    executable: action === CONTROL_ACTIONS.AUTO_EXECUTE
  };
}

function planText(plan) {
  return JSON.stringify(plan || {}).toLowerCase();
}

function allPlannedFiles(plan) {
  return [
    ...(Array.isArray(plan?.planned_files) ? plan.planned_files : []),
    ...(Array.isArray(plan?.files) ? plan.files : []),
    ...(Array.isArray(plan?.migration_plan?.files) ? plan.migration_plan.files : []),
    ...(Array.isArray(plan?.migration_files) ? plan.migration_files : [])
  ].map((file) => String(file || '').replace(/\\/g, '/'));
}

function hasDbMigration(plan) {
  const files = allPlannedFiles(plan);
  return files.some((file) => file.includes('supabase/migrations'));
}

function targetEnv(plan) {
  return plan?.target_env || plan?.environment || 'local';
}

function isProduction(plan) {
  return targetEnv(plan) === 'production';
}

function touchesRls(plan) {
  const text = planText(plan);
  return text.includes('rls') || text.includes('row level security') || text.includes('policy');
}

function touchesAuth(plan) {
  const text = planText(plan);
  return text.includes('auth') || text.includes('authentication') || text.includes('authorization') || text.includes('jwt') || text.includes('session');
}

function touchesAuthOrRls(plan) {
  return touchesAuth(plan) || touchesRls(plan);
}

function touchesExternalApi(plan) {
  const text = planText(plan);
  return text.includes('external api') || text.includes('webhook') || text.includes('third-party') || text.includes('third party') || text.includes('oauth');
}

function touchesSecrets(plan) {
  const text = planText(plan);
  return text.includes('secret') || text.includes('service_role') || text.includes('api key') || text.includes('token');
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
    'secret exposure',
    'git reset --hard',
    'force push',
    'main branch direct push'
  ];
  return destructivePatterns.some((pattern) => text.includes(pattern));
}

// Phase 2 #2: compute the content-based risk (the pre-existing substring
// logic) as a standalone helper so we can combine it with path-based risk.
function evaluateContentBasedRisk(plan) {
  let risk = createRisk(0, 'low', 'RISK_0_LOW');

  if (hasDbMigration(plan)) {
    risk = maxRisk(
      risk,
      isProduction(plan)
        ? createRisk(4, 'production_db_migration', 'RISK_4_PRODUCTION_DB')
        : createRisk(3, 'local_or_staging_db_migration', 'RISK_3A_DB_MIGRATION')
    );
  }

  if (touchesAuth(plan)) {
    risk = maxRisk(risk, createRisk(3, 'auth_logic_change', 'RISK_3B_AUTH_LOGIC'));
  }

  if (touchesRls(plan)) {
    risk = maxRisk(risk, createRisk(3, 'rls_policy_change', 'RISK_3C_RLS_POLICY'));
  }

  if (touchesExternalApi(plan)) {
    risk = maxRisk(risk, createRisk(3, 'external_api_integration', 'RISK_3D_EXTERNAL_API'));
  }

  if (touchesSecrets(plan)) {
    risk = maxRisk(risk, createRisk(4, 'secret_permission_or_handling', 'RISK_4_SECRET_ACCESS'));
  }

  if (isDestructive(plan)) {
    risk = createRisk(5, 'destructive_or_secret_risk', 'RISK_5_DESTRUCTIVE_OR_SECRET');
  }

  return risk;
}

function evaluateRisk(plan) {
  const contentRisk = evaluateContentBasedRisk(plan);
  const paths = pathsFromPlan(plan);
  const pathRisk = riskForPaths(paths);

  // Phase 2 #2 docs-only downgrade: when every touched path is docs/markdown
  // (path_risk.score === 0) and there are paths to evaluate, the content
  // risk is ignored even if substrings matched. A docs story that describes
  // RLS / auth / secrets concepts must not be gated as if it were changing
  // those concepts. This is the key chicken-and-egg break: Phase 1 soak
  // stories with security-related glossary content were unnecessarily
  // gated at PLAN_APPROVAL_PENDING under fullauto.
  //
  // Destructive content (Risk 5) is NEVER downgraded — even a docs file
  // saying "drop table users" or "force push to main" stays at Risk 5.
  // That keyword set is small and intentional.
  const docsOnly = pathRisk.paths_evaluated > 0
    && pathRisk.score === 0
    && contentRisk.score < 5;

  let finalRisk;
  if (docsOnly && contentRisk.score >= 2) {
    finalRisk = createRisk(0, 'docs_only_downgrade', 'RISK_0_DOCS_ONLY_DOWNGRADE', {
      content_risk_pre_downgrade: { score: contentRisk.score, category: contentRisk.category, label: contentRisk.label }
    });
  } else {
    finalRisk = contentRisk.score >= pathRisk.score
      ? contentRisk
      : createRisk(pathRisk.score, 'path_based', pathRisk.label);
  }

  return {
    ...finalRisk,
    requires_approval: finalRisk.score >= 2,
    control_model: 'control_decision_v1',
    path_risk: {
      score: pathRisk.score,
      label: pathRisk.label,
      paths_evaluated: pathRisk.paths_evaluated,
      paths_unmatched: pathRisk.paths_unmatched
    }
  };
}

function approvalTypeFromOptions(options = {}) {
  return options.approval_type || options.approvalType || 'plan';
}

function normalizeDecisionInput(risk, modeOrOptions = 'approval', envArg = 'local', approvalTypeArg = 'plan') {
  if (typeof modeOrOptions === 'object' && modeOrOptions !== null) {
    return {
      mode: modeOrOptions.mode || 'approval',
      target_env: modeOrOptions.target_env || modeOrOptions.env || envArg || 'local',
      approval_type: approvalTypeFromOptions(modeOrOptions),
      requested_action: modeOrOptions.requested_action || null,
      post_exec_diff_hash_changed: modeOrOptions.post_exec_diff_hash_changed === true,
      requires_diff_approval: modeOrOptions.requires_diff_approval === true,
      resume_after_security_stop: modeOrOptions.resume_after_security_stop === true,
      mode_change: modeOrOptions.mode_change === true
    };
  }
  return {
    mode: modeOrOptions || 'approval',
    target_env: envArg || 'local',
    approval_type: approvalTypeArg || 'plan',
    requested_action: null,
    post_exec_diff_hash_changed: false,
    requires_diff_approval: false,
    resume_after_security_stop: false,
    mode_change: false
  };
}

function decideControlAction(risk, modeOrOptions = 'approval', envArg = 'local', approvalTypeArg = 'plan') {
  const normalizedRisk = risk || createRisk(0, 'low', 'RISK_0_LOW');
  const input = normalizeDecisionInput(normalizedRisk, modeOrOptions, envArg, approvalTypeArg);
  const base = {
    mode: input.mode,
    target_env: input.target_env,
    risk_score: normalizedRisk.score,
    risk_category: normalizedRisk.category
  };

  if (normalizedRisk.score >= 5) {
    return controlDecision(CONTROL_ACTIONS.STOP, CONTROL_REASONS.RISK_5_SECURITY_STOP, base);
  }

  if (input.resume_after_security_stop) {
    return controlDecision(CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, CONTROL_REASONS.RESUME_AFTER_SECURITY_STOP_REQUIRES_PLAN_APPROVAL, { ...base, approval_type: APPROVAL_TYPES.RESUME_AFTER_SECURITY_STOP });
  }

  if (input.mode_change || input.approval_type === APPROVAL_TYPES.MODE_CHANGE || input.requested_action === 'mode_change') {
    return controlDecision(CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, CONTROL_REASONS.MODE_CHANGE_REQUIRES_PLAN_APPROVAL, { ...base, approval_type: APPROVAL_TYPES.MODE_CHANGE });
  }

  if (input.approval_type === APPROVAL_TYPES.DIFF || input.requires_diff_approval || input.post_exec_diff_hash_changed) {
    return controlDecision(CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL, CONTROL_REASONS.DIFF_APPROVAL_REQUIRED, { ...base, approval_type: APPROVAL_TYPES.DIFF });
  }

  if (input.target_env === 'production' && normalizedRisk.score >= 3) {
    return controlDecision(CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, CONTROL_REASONS.PRODUCTION_RISK_REQUIRES_PLAN_APPROVAL, { ...base, approval_type: APPROVAL_TYPES.PLAN });
  }

  if (input.mode === 'approval' && normalizedRisk.score >= 2) {
    return controlDecision(CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, CONTROL_REASONS.APPROVAL_MODE_RISK_THRESHOLD, { ...base, approval_type: APPROVAL_TYPES.PLAN });
  }

  if (input.mode === 'fullauto' && normalizedRisk.score >= 4) {
    return controlDecision(CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, CONTROL_REASONS.FULLAUTO_HIGH_RISK_THRESHOLD, { ...base, approval_type: APPROVAL_TYPES.PLAN });
  }

  return controlDecision(CONTROL_ACTIONS.AUTO_EXECUTE, CONTROL_REASONS.AUTO_EXECUTE_ALLOWED, base);
}

module.exports = {
  createRisk,
  controlDecision,
  evaluateContentBasedRisk,
  evaluateRisk,
  decideControlAction,
  targetEnv,
  hasDbMigration,
  touchesAuth,
  touchesRls,
  touchesAuthOrRls,
  touchesExternalApi,
  touchesSecrets,
  isDestructive
};
