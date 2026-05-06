const { verifyExecutionPreflight } = require('./execution-preflight');
const { appendExecutionLog } = require('./execution-log');

function buildNoopExecutionResult(approvalId, plan, preflight) {
  return {
    ok: true,
    executor: 'noop',
    approval_id: approvalId,
    story_id: plan.story_id || null,
    target_env: preflight.target_env,
    risk: preflight.risk,
    changed_files: Array.isArray(plan.planned_files) ? plan.planned_files : [],
    commands_executed: [],
    files_modified: [],
    execution_connected: false,
    message: 'No-op execution completed. No files, commands, migrations, or deploys were run.'
  };
}

function runExecutionHarness(approvalId, plan, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const executor = options.executor || 'noop';

  const preflight = verifyExecutionPreflight(approvalId, plan, {
    rootDir,
    current_diff_hash: options.current_diff_hash,
    mode: options.mode
  });

  if (!preflight.ok) {
    const event = appendExecutionLog({
      event: 'execution_preflight_failed',
      approval_id: approvalId,
      executor,
      reason: preflight.reason,
      preflight
    }, { rootDir });

    return {
      ok: false,
      reason: preflight.reason,
      preflight,
      log: event
    };
  }

  if (executor !== 'noop') {
    const event = appendExecutionLog({
      event: 'execution_executor_blocked',
      approval_id: approvalId,
      executor,
      reason: 'only_noop_executor_allowed_in_phase_3_0'
    }, { rootDir });

    return {
      ok: false,
      reason: 'only_noop_executor_allowed_in_phase_3_0',
      log: event
    };
  }

  const result = buildNoopExecutionResult(approvalId, plan, preflight);
  const event = appendExecutionLog({
    event: 'execution_noop_completed',
    approval_id: approvalId,
    executor,
    result
  }, { rootDir });

  return {
    ...result,
    preflight,
    log: event
  };
}

module.exports = {
  buildNoopExecutionResult,
  runExecutionHarness
};
