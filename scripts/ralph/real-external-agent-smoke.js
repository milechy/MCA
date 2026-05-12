#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runExternalAgentCandidatePatch } = require('../../src/ralph/external-agent-adapter');
const { runNemoClawOpenCodeCandidatePatch } = require('../../src/ralph/nemoclaw-opencode-gateway');
const { GATEWAY_TYPES, gatewayIsDevOnly, devOnlyGatewayAllowed } = require('../../src/ralph/external-agent-gateway');
const { recordLiveValidationResult } = require('../../src/ralph/live-validation-report');

const DEFAULT_SMOKE_PATH = 'tests/external-agent-generated.spec.js';
const DEFAULT_SMOKE_TASK = `Create a minimal candidate patch that adds only ${DEFAULT_SMOKE_PATH}. The unified diff must touch exactly ${DEFAULT_SMOKE_PATH}. Do not apply, commit, push, create pull requests, deploy, migrate, or modify the repository working tree.`;
const SUPPORTED_GATEWAYS = Object.freeze(['nemoclaw', 'openclaw']);
const BLOCKED_PROVIDER_REASONS = new Set([
  'provider_rate_limited',
  'candidate_patch_missing',
  'agent_output_contract_violation'
]);

function runtimeModeForGateway(gateway) {
  return gateway === GATEWAY_TYPES.NEMOCLAW ? 'nemoclaw-mediated' : 'dev-only-non-nemoclaw';
}

function mediatorForGateway(gateway) {
  return gateway === GATEWAY_TYPES.NEMOCLAW ? 'nemoclaw' : gateway;
}

function timestampId(prefix, date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `${prefix}-${stamp}`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { json_out: process.env.RALPH_EXTERNAL_AGENT_SMOKE_JSON_OUT || null, record_level: process.env.RALPH_EXTERNAL_AGENT_SMOKE_RECORD_LEVEL || null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json-out') options.json_out = argv[index += 1] || null;
    else if (arg === '--record-level') options.record_level = argv[index += 1] || null;
  }
  return options;
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

function safeRemoveRuntimePath(rootDir, relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return { ok: false, path: normalized, reason: 'path_not_allowed' };
  if (!normalized.startsWith('.ralph/external-agent-jobs') && !normalized.startsWith('.ralph/tmp/external-agent-smoke')) {
    return { ok: false, path: normalized, reason: 'not_real_external_agent_smoke_runtime_path' };
  }
  const absolute = path.resolve(rootDir, normalized);
  if (!absolute.startsWith(path.resolve(rootDir, '.ralph'))) return { ok: false, path: normalized, reason: 'outside_ralph_runtime' };
  try {
    if (!fs.existsSync(absolute)) return { ok: true, path: normalized, removed: false, reason: 'missing' };
    fs.rmSync(absolute, { recursive: true, force: true });
    return { ok: true, path: normalized, removed: true, reason: null };
  } catch (error) {
    return { ok: false, path: normalized, reason: 'remove_failed' };
  }
}

function cleanupSmokeRuntime(rootDir, { jobId, sandboxRoot, keep_runtime_artifacts = false } = {}) {
  if (keep_runtime_artifacts) return { kept: true, removed: [], skipped: [] };
  const candidates = [];
  if (jobId) candidates.push(`.ralph/external-agent-jobs/${jobId}.json`);
  if (sandboxRoot) candidates.push(sandboxRoot);
  const removed = [];
  const skipped = [];
  for (const candidate of Array.from(new Set(candidates))) {
    const result = safeRemoveRuntimePath(rootDir, candidate);
    if (result.ok && result.removed) removed.push(result.path);
    else skipped.push(result);
  }
  return { kept: false, removed, skipped };
}

function gitRestoreRuntimeFiles(rootDir) {
  try {
    execFileSync('git', ['restore', '.ralph/approval-log.jsonl'], { cwd: rootDir, stdio: 'ignore' });
  } catch {}
}

function skipped(reason, extra = {}) {
  const cleanup = extra.rootDir ? cleanupSmokeRuntime(extra.rootDir, extra) : { removed: [], skipped: [] };
  return {
    ok: true,
    skipped: true,
    stage: 'real_external_agent_smoke',
    reason,
    gateway_type: extra.gateway_type || null,
    gateway_name: extra.gateway_name || null,
    opencode_runtime_mode: runtimeModeForGateway(extra.gateway_type),
    mediator: mediatorForGateway(extra.gateway_type),
    dev_only_gateway: gatewayIsDevOnly(extra.gateway_type),
    job_id: extra.job_id || null,
    approval_id: extra.approval_id || null,
    sandbox_root: extra.sandbox_root || null,
    runtime_installed: false,
    cleanup,
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
  const cleanup = extra.rootDir ? cleanupSmokeRuntime(extra.rootDir, extra) : { removed: [], skipped: [] };
  return {
    ok: false,
    skipped: false,
    blocked: BLOCKED_PROVIDER_REASONS.has(reason),
    stage: 'real_external_agent_smoke',
    reason,
    gateway_type: extra.gateway_type || null,
    gateway_name: extra.gateway_name || null,
    opencode_runtime_mode: runtimeModeForGateway(extra.gateway_type),
    mediator: mediatorForGateway(extra.gateway_type),
    dev_only_gateway: gatewayIsDevOnly(extra.gateway_type),
    job_id: extra.job_id || null,
    approval_id: extra.approval_id || null,
    sandbox_root: extra.sandbox_root || null,
    runtime_installed: extra.runtime_installed === true,
    run: extra.run || null,
    cleanup,
    working_tree_clean_before: extra.working_tree_clean_before === true,
    working_tree_clean_after: gitStatusShort(extra.rootDir || process.cwd()) === '',
    execution_connected: extra.execution_connected === true,
    real_gateway_process_started: extra.real_gateway_process_started === true,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: reason === 'dev_only_gateway_requires_explicit_opt_in'
      ? 'rerun_with_explicit_dev_only_gateway_opt_in_or_use_nemoclaw'
      : BLOCKED_PROVIDER_REASONS.has(reason)
        ? 'retry_level_1_after_provider_recovers_or_record_blocked_outcome'
        : 'fix_real_external_agent_smoke_failure'
  };
}

function normalizeGateway(value) {
  const gateway = String(value || 'nemoclaw').trim().toLowerCase();
  return SUPPORTED_GATEWAYS.includes(gateway) ? gateway : null;
}

function runGatewayCandidatePatch({ gateway, rootDir, approvalId, jobId, sandboxRoot, requested_paths, task, command, env, timeout_ms, allow_dev_only_gateway, now }) {
  if (gateway === GATEWAY_TYPES.NEMOCLAW) {
    return runNemoClawOpenCodeCandidatePatch({
      rootDir,
      approval_id: approvalId,
      job_id: jobId,
      sandbox_root: sandboxRoot,
      requested_paths,
      task,
      command: command || 'nemoclaw',
      env,
      timeout_ms,
      now
    });
  }
  return runExternalAgentCandidatePatch({
    rootDir,
    approval_id: approvalId,
    job_id: jobId,
    gateway_type: gateway,
    gateway_name: gateway,
    sandbox_root: sandboxRoot,
    requested_paths,
    task,
    command,
    env,
    timeout_ms,
    explicit_runtime_approval: true,
    allow_dev_only_gateway,
    now
  });
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
  explicit_runtime_approval = process.env.RALPH_EXTERNAL_AGENT_RUNTIME_APPROVED === 'true',
  allow_dev_only_gateway = process.env.RALPH_EXTERNAL_AGENT_DEV_ONLY_GATEWAY_ALLOWED === 'true',
  keep_runtime_artifacts = process.env.RALPH_EXTERNAL_AGENT_KEEP_RUNTIME_ARTIFACTS === 'true'
} = {}) {
  const gateway = normalizeGateway(gateway_type);
  const date = now();
  const approvalId = timestampId('APR-EXTAGENT-REAL-SMOKE', date);
  const jobId = timestampId('JOB-EXTAGENT', date);
  const sandboxRoot = `.ralph/tmp/external-agent-smoke/${approvalId}`;
  const context = { rootDir, jobId, approval_id: approvalId, approvalId, sandboxRoot, sandbox_root: sandboxRoot, keep_runtime_artifacts };

  if (!gateway) return blocked('gateway_type_not_allowed', { ...context, gateway_type, job_id: jobId, approval_id: approvalId });
  if (gatewayIsDevOnly(gateway) && !devOnlyGatewayAllowed({ allow_dev_only_gateway, env })) {
    return blocked('dev_only_gateway_requires_explicit_opt_in', { ...context, gateway_type: gateway, gateway_name: gateway, job_id: jobId, approval_id: approvalId });
  }
  const runtimeCommand = command || gateway;
  if (!commandExists(runtimeCommand, { env })) {
    return skipped('runtime_not_installed', { ...context, rootDir, gateway_type: gateway, gateway_name: gateway, job_id: jobId, approval_id: approvalId });
  }
  if (explicit_runtime_approval !== true) {
    return blocked('explicit_runtime_approval_required', { ...context, gateway_type: gateway, gateway_name: gateway, job_id: jobId, approval_id: approvalId, runtime_installed: true });
  }

  gitRestoreRuntimeFiles(rootDir);
  const statusBefore = gitStatusShort(rootDir);
  if (statusBefore === null) return blocked('git_status_failed', { ...context, gateway_type: gateway, gateway_name: gateway, job_id: jobId, approval_id: approvalId, runtime_installed: true });
  if (statusBefore !== '') return blocked('working_tree_dirty_before_smoke', { ...context, gateway_type: gateway, gateway_name: gateway, job_id: jobId, approval_id: approvalId, runtime_installed: true, working_tree_clean_before: false });

  const run = runGatewayCandidatePatch({ gateway, rootDir, approvalId, jobId, sandboxRoot, requested_paths, task, command: runtimeCommand, env, timeout_ms, allow_dev_only_gateway, now });
  gitRestoreRuntimeFiles(rootDir);
  const cleanup = cleanupSmokeRuntime(rootDir, { jobId, sandboxRoot, keep_runtime_artifacts });

  const statusAfter = gitStatusShort(rootDir);
  const cleanAfter = statusAfter === '';
  const ok = run.ok === true && cleanAfter;
  const reason = ok ? null : run.ok ? 'working_tree_dirty_after_smoke' : run.reason;
  return {
    ok,
    skipped: false,
    blocked: BLOCKED_PROVIDER_REASONS.has(reason),
    stage: 'real_external_agent_smoke',
    reason,
    gateway_type: gateway,
    gateway_name: gateway,
    opencode_runtime_mode: runtimeModeForGateway(gateway),
    mediator: mediatorForGateway(gateway),
    dev_only_gateway: gatewayIsDevOnly(gateway),
    job_id: jobId,
    approval_id: approvalId,
    sandbox_root: sandboxRoot,
    candidate_patch_path: run.candidate_patch_path,
    run: { ...run, opencode_runtime_mode: runtimeModeForGateway(gateway), mediator: mediatorForGateway(gateway), dev_only_gateway: gatewayIsDevOnly(gateway) },
    runtime_installed: true,
    cleanup,
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
    next_action: ok
      ? 'review_candidate_patch_then_continue_approval_chain'
      : BLOCKED_PROVIDER_REASONS.has(reason)
        ? 'retry_level_1_after_provider_recovers_or_record_blocked_outcome'
        : 'fix_real_external_agent_smoke_failure'
  };
}

function maybeRecord(result, { rootDir, json_out, record_level }) {
  if (!json_out && record_level === null) return { result, record: null };
  const level = record_level === null || record_level === undefined || record_level === '' ? 1 : Number(record_level);
  const record = recordLiveValidationResult({ rootDir, level, smoke_result: result, output_path: json_out || undefined });
  return { result: { ...result, validation_report: record.output || null }, record };
}

function main() {
  const rootDir = path.resolve(__dirname, '..', '..');
  const options = parseArgs();
  const result = runRealExternalAgentSmoke({ rootDir });
  const recorded = maybeRecord(result, { rootDir, json_out: options.json_out, record_level: options.record_level });
  process.stdout.write(`${JSON.stringify(recorded.result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_SMOKE_PATH,
  DEFAULT_SMOKE_TASK,
  SUPPORTED_GATEWAYS,
  BLOCKED_PROVIDER_REASONS,
  parseArgs,
  runtimeModeForGateway,
  mediatorForGateway,
  timestampId,
  gitStatusShort,
  commandExists,
  safeRemoveRuntimePath,
  cleanupSmokeRuntime,
  runGatewayCandidatePatch,
  runRealExternalAgentSmoke,
  maybeRecord
};
