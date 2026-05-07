const fs = require('node:fs');
const path = require('node:path');

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function sandboxSummaryPath(rootDir, sandboxRoot) {
  return path.join(rootDir, sandboxRoot, 'dry-run-summary.json');
}

function assertSandboxLocalPath(rootDir, sandboxRoot, filePath) {
  const sandboxAbs = path.resolve(rootDir, sandboxRoot);
  const fileAbs = path.resolve(filePath);
  return fileAbs === sandboxAbs || fileAbs.startsWith(`${sandboxAbs}${path.sep}`);
}

function makeBlockedResult(preflight, reason) {
  const now = new Date().toISOString();
  return {
    ok: false,
    stage: 'opencode_sandbox_dry_execution',
    reason,
    runner: 'fake_opencode_sandbox_runner',
    approval_id: preflight?.approval_id || null,
    sandbox_root: preflight?.sandbox_root || null,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    preflight_ok: preflight?.ok === true,
    opencode_execution_started: false,
    real_opencode_process_started: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_preflight_failure'
  };
}

function runFakeOpenCodeSandbox(preflight, { rootDir = process.cwd(), now = () => new Date() } = {}) {
  if (!preflight || preflight.ok !== true || preflight.start_allowed !== true) {
    return makeBlockedResult(preflight, preflight?.reason || 'preflight_required');
  }

  const startedAt = now().toISOString();
  const summaryPath = sandboxSummaryPath(rootDir, preflight.sandbox_root);
  if (!assertSandboxLocalPath(rootDir, preflight.sandbox_root, summaryPath)) {
    return makeBlockedResult(preflight, 'sandbox_summary_path_not_allowed');
  }

  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  const summary = {
    runner: 'fake_opencode_sandbox_runner',
    approval_id: preflight.approval_id,
    sandbox_root: preflight.sandbox_root,
    requested_paths: preflight.requested_paths || [],
    real_opencode_process_started: false,
    commands_executed: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  const finishedAt = now().toISOString();
  const relativeSummaryPath = path.relative(rootDir, summaryPath).replace(/\\/g, '/');

  return {
    ok: true,
    stage: 'opencode_sandbox_dry_execution',
    reason: null,
    runner: 'fake_opencode_sandbox_runner',
    approval_id: preflight.approval_id,
    sandbox_root: preflight.sandbox_root,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    preflight_ok: true,
    opencode_execution_started: false,
    real_opencode_process_started: false,
    commands_executed: [],
    files_modified: [relativeSummaryPath],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'review_sandbox_dry_run_summary_then_consider_phase12_7_real_opencode'
  };
}

module.exports = {
  durationMs,
  sandboxSummaryPath,
  assertSandboxLocalPath,
  runFakeOpenCodeSandbox
};
