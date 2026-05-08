const { getApproval, summarizeApproval } = require('./approval-reader');
const { calculatePlanHash, calculateDiffHash } = require('./hash');
const { loadMode } = require('./mode-manager');
const { evaluateRisk, targetEnv } = require('./risk-evaluator');
const { decideProductionChangePolicy } = require('./production-change-policy');

function fail(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function pass(details = {}) {
  return { ok: true, ...details };
}

function verifyExecutionPreflight(approvalId, plan, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const approval = getApproval(approvalId, { rootDir });

  if (!approval) {
    return fail('approval_not_found', { approval_id: approvalId });
  }

  const approvalSummary = summarizeApproval(approval);

  if (approval.status !== 'approved') {
    return fail(`approval_status_${approval.status}`, { approval: approvalSummary });
  }

  if (approval.execution_requires_hash_verification !== true) {
    return fail('execution_hash_verification_not_required_by_approval', { approval: approvalSummary });
  }

  if (approval.execution_connected === true) {
    return fail('approval_already_execution_connected', { approval: approvalSummary });
  }

  if (new Date(approval.expires_at).getTime() < Date.now()) {
    return fail('approval_expired', { approval: approvalSummary });
  }

  const currentPlanHash = calculatePlanHash(plan);
  if (currentPlanHash !== approval.plan_hash) {
    return fail('plan_hash_mismatch', {
      expected: approval.plan_hash,
      actual: currentPlanHash,
      approval: approvalSummary
    });
  }

  const currentDiffHash = options.current_diff_hash || calculateDiffHash(rootDir);
  if (currentDiffHash !== approval.pre_exec_diff_hash) {
    return fail('pre_exec_diff_hash_mismatch', {
      expected: approval.pre_exec_diff_hash,
      actual: currentDiffHash,
      approval: approvalSummary
    });
  }

  const currentMode = options.mode || loadMode(rootDir);
  if (!['approval', 'fullauto'].includes(currentMode.mode)) {
    return fail('mode_not_allowed_for_execution', { mode: currentMode, approval: approvalSummary });
  }

  const risk = evaluateRisk(plan);
  if (risk.score >= 5) {
    return fail('risk_5_execution_blocked', { risk, approval: approvalSummary });
  }

  const env = targetEnv(plan);
  const productionPolicy = decideProductionChangePolicy(plan, {
    mode: currentMode.mode,
    post_exec_diff_hash_changed: options.post_exec_diff_hash_changed === true
  });

  if (!productionPolicy.ok) {
    return fail(productionPolicy.reason, { risk, target_env: env, production_policy: productionPolicy, approval: approvalSummary });
  }

  if (productionPolicy.target_env === 'production') {
    return fail('production_execution_requires_separate_apply_path', { risk, target_env: env, production_policy: productionPolicy, approval: approvalSummary });
  }

  if (productionPolicy.diff_approval_required === true) {
    return fail('diff_approval_required_before_execution', { risk, target_env: env, production_policy: productionPolicy, approval: approvalSummary });
  }

  return pass({
    approval: approvalSummary,
    mode: currentMode,
    risk,
    target_env: env,
    production_policy: productionPolicy,
    execution_connected: false,
    next_action: 'EXECUTION_ALLOWED_BY_PREFLIGHT_ONLY'
  });
}

module.exports = {
  verifyExecutionPreflight
};
