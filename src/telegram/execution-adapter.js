const fs = require('node:fs');
const path = require('node:path');
const { runExecutionHarness } = require('../ralph/execution-harness');

const EMPTY_DIFF_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function isAllowedTmpPlanPath(planPath) {
  if (!planPath || typeof planPath !== 'string') return false;
  if (path.isAbsolute(planPath)) return false;
  if (planPath.includes('..')) return false;
  return /^\.ralph\/tmp\/[A-Za-z0-9._-]+\.json$/.test(planPath);
}

function executeNoopFromTelegram(approvalId, planPath, options = {}) {
  const rootDir = options.rootDir || process.cwd();

  if (!approvalId) {
    return { ok: false, reason: 'approval_id_required', wired_to_runtime: false };
  }

  if (!isAllowedTmpPlanPath(planPath)) {
    return {
      ok: false,
      reason: 'plan_path_not_allowed',
      allowed_pattern: '.ralph/tmp/*.json',
      wired_to_runtime: false
    };
  }

  const fullPlanPath = path.join(rootDir, planPath);
  if (!fs.existsSync(fullPlanPath)) {
    return { ok: false, reason: 'plan_file_not_found', plan_path: planPath, wired_to_runtime: false };
  }

  const plan = JSON.parse(fs.readFileSync(fullPlanPath, 'utf8'));
  const result = runExecutionHarness(approvalId, plan, {
    rootDir,
    executor: 'noop',
    current_diff_hash: options.current_diff_hash || EMPTY_DIFF_HASH
  });

  return {
    ...result,
    wired_to_runtime: false,
    execution_connected: false,
    plan_path: planPath
  };
}

module.exports = {
  EMPTY_DIFF_HASH,
  isAllowedTmpPlanPath,
  executeNoopFromTelegram
};
