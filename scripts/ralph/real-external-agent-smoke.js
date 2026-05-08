#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runExternalAgentCandidatePatch } = require('../../src/ralph/external-agent-adapter');

const DEFAULT_SMOKE_PATH = 'tests/external-agent-generated.spec.js';
const DEFAULT_SMOKE_TASK = `Create a minimal candidate patch that adds only ${DEFAULT_SMOKE_PATH}. The unified diff must touch exactly ${DEFAULT_SMOKE_PATH}. Do not apply, commit, push, create pull requests, deploy, migrate, or modify the repository working tree.`;
const SUPPORTED_GATEWAYS = Object.freeze(['nemoclaw', 'openclaw']);

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

function commandExists(command, { env = process.env } = {}) {
  try {
    execFileSync('command', ['-v', command], { shell: true, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function gitRestoreRuntimeFiles(rootDir) {
  try {
    execFileSync('git', ['restore', '.ralph/approval-log.jsonl'], { cwd: rootDir, stdio: 'ignore' });
  } catch {}
}

function skipped(reason, extra = {}) {
  return {
    ok: true,
    skipped: true,
    stage: 'real_external_agent_smoke',
    reason,
    gateway_type: extra.gateway_type || null,
    gateway_name: extra.gateway_name || null,
    job_id: extra.job_id || null,
    approval_id: extra.approval_id || null,
    sandbox_root: extra.sandbox_root || null,
    runtime_installed: false,
    execution_connected: false,
    real_gateway_process_started: false,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'install_runtime_or_continue_without_external_agent_smoke'
  };
}

function blocked(reason, extra = {}) {
  if (extra.rootDir) gitRestoreRuntimeFiles(extra.rootDir);
  return {
    ok: false,
    skipped: false,
    stage: 'real_external_agent_smoke',
    reason,
    gateway_type: extra.gateway_type || null,
    gateway_name: extra.gateway_name || null,
    job_id: extra.job_id || null,
    approval_id: extra.approval_id || null,
    sandbox_root: extra.sandbox_root || null,
    runtime_installed: extra.runtime_installed === true,
    run: extra.run || null,
    working_tree_clean_before: extra.working_tree_clean_before === true,
    working_tree_clean_after: gitStatusShort(extra.rootDir || process.cwd()) === '',
    execution_connected: false,
    real_gateway_process_started: false,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_real_external_agent_smoke_failure'
  };
}

function normalizeGateway(value) {
  const gateway = String(value || 'nemoclaw').trim().toLowerCase();
  return SUPPORTED_GATEWAYS.includes(gateway) ? gateway : null;
}

function runRealExternalAgentSmoke({
  rootDir = process.cwd(),
  gateway_type = process.env.RALPH_EXTERNAL_AGENT_SMOKE_GATEWAY || 'nemoclaw',
  task = process.env.RALPH_EXTERNAL_AGENT_SMOKE_TASK || DEFAULT_SMOKE_TASK,
  requested_paths = [DEFAULT_SMOKE_PATH],
  env = process.env,
  now = () => new Date(),
  timeout_ms = 60000,
  command,
  explicit_runtime_approval = process.env.RALPH_EXTERNAL_AGENT_RUNTIME_APPROVED === 'true'
} = {}) {
  const gateway = normalizeGateway(gateway_type);
  const date = now();
  const approvalId = timestampId('APR-EXTAGENT-REAL-SMOKE', date);
  const jobId = timestampId('JOB-EXTAGENT', date);
  const sandboxRoot = `.ralph/tmp/external-agent-smoke/${approvalId}`;

  if (!gateway) return blocked('gateway_type_not_allowed', { rootDir, gateway_type, job_id: jobId, approval_id: approvalId, sandbox_root: sandboxRoot });
  const runtimeCommand = command || gateway;
  if (!commandExists(runtimeCommand, { env })) {
    return skipped('runtime_not_installed', { gateway_type: gateway, gateway_name: gateway, job_id: jobId, approval_id: approvalId, sandbox_root: sandboxRoot });
  }
  if (explicit_runtime_approval !== true) {
    return blocked('explicit_runtime_approval_required', { rootDir, gateway_type: gateway, gateway_name: gateway, job_id: jobId, approval_id: approvalId, sandbox_root: sandboxRoot, runtime_installed: true });
  }

  gitRestoreRuntimeFiles(rootDir);
  const statusBefore = gitStatusShort(rootDir);
  if (statusBefore === null) return blocked('git_status_failed', { rootDir, gateway_type: gateway, gateway_name: gateway, job_id: jobId, approval_id: approvalId, sandbox_root: sandboxRoot, runtime_installed: true });
  if (statusBefore !== '') return blocked('working_tree_dirty_before_smoke', { rootDir, gateway_type: gateway, gateway_name: gateway, job_id: jobId, approval_id: approvalId, sandbox_root: sandboxRoot, runtime_installed: true, working_tree_clean_before: false });

  const run = runExternalAgentCandidatePatch({
    rootDir,
    approval_id: approvalId,
    job_id: jobId,
    gateway_type: gateway,
    gateway_name: gateway,
    sandbox_root: sandboxRoot,
    requested_paths,
    task,
    command: runtimeCommand,
    env,
    timeout_ms,
    explicit_runtime_approval: true,
    now
  });
  gitRestoreRuntimeFiles(rootDir);

  const statusAfter = gitStatusShort(rootDir);
  const cleanAfter = statusAfter === '';
  const ok = run.ok === true && cleanAfter;
  return {
    ok,
    skipped: false,
    stage: 'real_external_agent_smoke',
    reason: ok ? null : run.ok ? 'working_tree_dirty_after_smoke' : run.reason,
    gateway_type: gateway,
    gateway_name: gateway,
    job_id: jobId,
    approval_id: approvalId,
    sandbox_root: sandboxRoot,
    candidate_patch_path: run.candidate_patch_path,
    run,
    runtime_installed: true,
    working_tree_clean_before: true,
    working_tree_clean_after: cleanAfter,
    execution_connected: run.execution_connected === true,
    real_gateway_process_started: run.real_gateway_process_started === true,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: ok ? 'review_candidate_patch_then_continue_approval_chain' : 'fix_real_external_agent_smoke_failure'
  };
}

function main() {
  const result = runRealExternalAgentSmoke({ rootDir: path.resolve(__dirname, '..', '..') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_SMOKE_PATH,
  DEFAULT_SMOKE_TASK,
  SUPPORTED_GATEWAYS,
  timestampId,
  gitStatusShort,
  commandExists,
  runRealExternalAgentSmoke
};
