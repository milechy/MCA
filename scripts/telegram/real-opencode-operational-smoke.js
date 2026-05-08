#!/usr/bin/env node
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { makeOpenCodeSandboxPlan } = require('../../src/telegram/opencode-sandbox-plan');
const { OPENCODE_SANDBOX_ENV, opencodeSandboxRunnerPreflight } = require('../../src/telegram/opencode-sandbox-preflight');
const { OPENCODE_CLI_ENV } = require('../../src/telegram/opencode-real-adapter');
const { runOpenCodeCandidatePatch } = require('../../src/telegram/opencode-run');
const { defaultJobId, writeJob } = require('../../src/telegram/opencode-jobs');

const DEFAULT_SMOKE_PATH = 'tests/opencode-generated.spec.js';
const DEFAULT_SMOKE_TASK = `Create a minimal candidate patch that adds only ${DEFAULT_SMOKE_PATH}. The unified diff must touch exactly ${DEFAULT_SMOKE_PATH}. The file content should be a tiny Playwright test named generated candidate patch. Do not touch smoke-test.txt or any other path.`;

function timestampId(prefix, date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `${prefix}-${stamp}`;
}

function gitStatusShort(rootDir) {
  try {
    return execFileSync('git', ['status', '--short'], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function gitRestoreTrackedRuntimeFiles(rootDir) {
  try {
    execFileSync('git', ['restore', '.ralph/approval-log.jsonl'], { cwd: rootDir, stdio: 'ignore' });
  } catch {}
}

function runPreSecretScan(rootDir) {
  try {
    execFileSync(process.execPath, ['scripts/telegram/preflight-no-secrets.js'], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function blocked(reason, extra = {}) {
  if (extra.rootDir) gitRestoreTrackedRuntimeFiles(extra.rootDir);
  return {
    ok: false,
    stage: 'real_opencode_operational_smoke',
    reason,
    approval_id: extra.approval_id || null,
    job_id: extra.job_id || null,
    sandbox_root: extra.sandbox_root || null,
    command: null,
    candidate_patch_path: null,
    run: null,
    job: null,
    pre_secret_scan_ok: extra.pre_secret_scan_ok === true,
    working_tree_clean_before: extra.working_tree_clean_before === true,
    working_tree_clean_after: gitStatusShort(extra.rootDir || process.cwd()) === '',
    execution_connected: false,
    opencode_execution_started: false,
    real_opencode_process_started: false,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_real_opencode_operational_smoke_failure'
  };
}

function runRealOpenCodeOperationalSmoke({
  rootDir = process.cwd(),
  intent = `real OpenCode operational smoke candidate patch for ${DEFAULT_SMOKE_PATH}`,
  task = DEFAULT_SMOKE_TASK,
  requested_paths = [DEFAULT_SMOKE_PATH],
  env = process.env,
  now = () => new Date(),
  pre_secret_scan_ok,
  use_test_double = false,
  timeout_ms = 60000
} = {}) {
  const date = now();
  const approvalId = timestampId('APR-OPENCODE-REAL-SMOKE', date);
  const jobId = defaultJobId(date);
  const plan = makeOpenCodeSandboxPlan({ approval_id: approvalId, intent });
  if (!plan.ok) return blocked(plan.reason || 'sandbox_plan_failed', { rootDir, approval_id: approvalId, job_id: jobId, sandbox_root: plan.sandbox_root });

  gitRestoreTrackedRuntimeFiles(rootDir);
  const statusBefore = gitStatusShort(rootDir);
  if (statusBefore === null) return blocked('git_status_failed', { rootDir, approval_id: approvalId, job_id: jobId, sandbox_root: plan.sandbox_root });
  if (statusBefore !== '') return blocked('working_tree_dirty_before_smoke', { rootDir, approval_id: approvalId, job_id: jobId, sandbox_root: plan.sandbox_root, working_tree_clean_before: false });

  const secretScanOk = pre_secret_scan_ok === undefined ? runPreSecretScan(rootDir) : pre_secret_scan_ok === true;
  if (!secretScanOk) return blocked('pre_secret_scan_failed', { rootDir, approval_id: approvalId, job_id: jobId, sandbox_root: plan.sandbox_root, pre_secret_scan_ok: false, working_tree_clean_before: true });

  createApproval(plan, plan.risk, {
    rootDir,
    approval_id: approvalId,
    requested_action: 'opencode_real_operational_smoke',
    allowed_user_ids: [],
    expires_at: new Date(date.getTime() + 30 * 60 * 1000).toISOString()
  });
  approveApprovalRecordOnly(approvalId, 'opencode-real-smoke', { rootDir, channel: 'local-smoke' });
  gitRestoreTrackedRuntimeFiles(rootDir);

  const smokeEnv = {
    ...env,
    [OPENCODE_SANDBOX_ENV]: 'true'
  };
  const fixturePath = path.resolve(rootDir, 'tests/fixtures/opencode-candidate-patch-double.js');
  const commandOverride = use_test_double ? process.execPath : undefined;
  const argsOverride = use_test_double ? [fixturePath] : undefined;
  const preflight = opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: approvalId,
    sandbox_root: plan.sandbox_root,
    requested_paths,
    pre_secret_scan_ok: true,
    env: smokeEnv,
    now: date
  });
  if (!preflight.ok) return blocked(preflight.reason || 'sandbox_preflight_failed', { rootDir, approval_id: approvalId, job_id: jobId, sandbox_root: plan.sandbox_root, pre_secret_scan_ok: true, working_tree_clean_before: true });

  const run = runOpenCodeCandidatePatch(preflight, {
    rootDir,
    task,
    command: commandOverride,
    args: argsOverride,
    env: smokeEnv,
    timeout_ms,
    now
  });
  gitRestoreTrackedRuntimeFiles(rootDir);
  const statusAfterRun = gitStatusShort(rootDir);
  const jobWrite = writeJob(rootDir, {
    job_id: jobId,
    status: run.ok ? 'completed' : 'failed',
    approval_id: approvalId,
    sandbox_root: plan.sandbox_root,
    command_type: 'opencode_run',
    task_preview: run.task_preview,
    started_at: run.started_at,
    updated_at: run.finished_at,
    finished_at: run.finished_at,
    exit_code: run.exit_code,
    stdout_preview: run.stdout_preview,
    stderr_preview: run.stderr_preview,
    execution_connected: run.execution_connected,
    opencode_execution_started: run.opencode_execution_started,
    commands_executed: run.commands_executed,
    files_modified: run.files_modified,
    repository_files_modified: run.repository_files_modified,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: run.next_action
  });
  gitRestoreTrackedRuntimeFiles(rootDir);

  const statusAfter = gitStatusShort(rootDir);
  const cleanAfter = statusAfter === '';
  const ok = run.ok === true && cleanAfter;
  return {
    ok,
    stage: 'real_opencode_operational_smoke',
    reason: ok ? null : run.ok ? 'working_tree_dirty_after_smoke' : run.reason,
    approval_id: approvalId,
    job_id: jobId,
    sandbox_root: plan.sandbox_root,
    command: run.command_preview,
    candidate_patch_path: run.candidate_patch_path,
    run,
    job: jobWrite.summary || null,
    opencode_cli: smokeEnv[OPENCODE_CLI_ENV] || 'opencode',
    test_double_used: use_test_double === true,
    pre_secret_scan_ok: true,
    working_tree_clean_before: true,
    working_tree_clean_after: cleanAfter,
    status_after_run_before_job_write: statusAfterRun,
    execution_connected: run.execution_connected === true,
    opencode_execution_started: run.opencode_execution_started === true,
    real_opencode_process_started: run.real_opencode_process_started === true,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: ok ? 'review_candidate_patch_then_continue_approval_chain' : 'fix_real_opencode_operational_smoke_failure'
  };
}

function main() {
  const result = runRealOpenCodeOperationalSmoke({
    rootDir: path.resolve(__dirname, '..', '..'),
    intent: process.env.RALPH_OPENCODE_SMOKE_INTENT || undefined,
    task: process.env.RALPH_OPENCODE_SMOKE_TASK || undefined,
    use_test_double: process.env.RALPH_OPENCODE_SMOKE_TEST_DOUBLE === 'true'
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runRealOpenCodeOperationalSmoke, timestampId, gitStatusShort, gitRestoreTrackedRuntimeFiles, DEFAULT_SMOKE_PATH, DEFAULT_SMOKE_TASK };
