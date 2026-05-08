const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildExternalGatewayPolicy, gatewayRuntimeDependencyApproved, GATEWAY_ACTIONS } = require('./external-agent-gateway');
const { defaultExternalAgentJobId, writeExternalAgentJob } = require('./external-agent-jobs');

const DEFAULT_TIMEOUT_MS = 60000;
const ALLOWED_RUNTIME_COMMANDS = Object.freeze({
  nemoclaw: 'nemoclaw',
  openclaw: 'openclaw',
  generic: 'external-agent'
});
const FORBIDDEN_ARGS = Object.freeze([
  '--apply',
  '--commit',
  '--push',
  '--pr',
  '--pull-request',
  '--merge',
  '--deploy',
  '--migrate',
  '--migration',
  '--dangerously-skip-permissions',
  '--shell',
  '--command'
]);

function oneLine(value, maxLength = 240) {
  const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function redact(value) {
  return oneLine(String(value || '').replace(/\d{8,}:[A-Za-z0-9_-]{20,}/g, '<redacted>').replace(/ghp_[A-Za-z0-9_]{20,}/g, '<redacted>').replace(/sk-[A-Za-z0-9_-]{20,}/g, '<redacted>'));
}

function normalizeRuntimeCommand(gatewayType, command) {
  const expected = ALLOWED_RUNTIME_COMMANDS[gatewayType];
  const provided = String(command || expected || '').trim();
  if (!expected || provided !== expected) return null;
  return provided;
}

function buildAdapterArgs({ task, candidate_patch_path, requested_paths }) {
  return [
    'run',
    '--candidate-patch',
    candidate_patch_path,
    '--requested-paths',
    requested_paths.join(','),
    '--task',
    task
  ];
}

function argsAreAllowed(args) {
  if (!Array.isArray(args)) return false;
  const joined = args.join(' ');
  if (/[;&|`$<>]/.test(joined)) return false;
  return !args.some((arg) => FORBIDDEN_ARGS.includes(String(arg)));
}

function ensureSandboxDir(rootDir, sandboxRoot) {
  const resolved = path.resolve(rootDir, sandboxRoot);
  const expectedPrefix = path.resolve(rootDir, '.ralph', 'tmp');
  if (!resolved.startsWith(expectedPrefix)) return null;
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function makeBase(overrides = {}) {
  return {
    ok: false,
    stage: 'external_agent_candidate_patch_adapter',
    reason: null,
    job_id: null,
    gateway_type: null,
    gateway_name: null,
    sandbox_root: null,
    candidate_patch_path: null,
    command_preview: null,
    exit_code: null,
    stdout_preview: '',
    stderr_preview: '',
    duration_ms: 0,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    execution_connected: false,
    real_gateway_process_started: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false,
    raw_log_allowed: false,
    files_modified: [],
    repository_files_modified: [],
    job: null,
    next_action: 'fix_external_agent_adapter_failure',
    ...overrides
  };
}

function writeAdapterJob(rootDir, result, { approval_id, task_preview, started_at, finished_at, status }) {
  if (!result.job_id) return result;
  const written = writeExternalAgentJob(rootDir, {
    job_id: result.job_id,
    status,
    approval_id,
    gateway_type: result.gateway_type,
    gateway_name: result.gateway_name,
    sandbox_root: result.sandbox_root,
    candidate_patch_path: result.candidate_patch_path,
    task_preview,
    started_at,
    updated_at: finished_at,
    finished_at,
    exit_code: result.exit_code,
    stdout_preview: result.stdout_preview,
    stderr_preview: result.stderr_preview,
    execution_connected: result.execution_connected,
    real_gateway_process_started: result.real_gateway_process_started,
    commands_executed: result.command_preview ? [result.command_preview] : [],
    files_modified: result.files_modified,
    next_action: result.next_action
  });
  return { ...result, job: written.ok ? written.summary : null };
}

function runExternalAgentCandidatePatch({
  rootDir = process.cwd(),
  approval_id = null,
  job_id,
  gateway_type,
  gateway_name,
  sandbox_root,
  requested_paths = [],
  task,
  command,
  args,
  env = process.env,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  explicit_runtime_approval = false,
  spawn = spawnSync,
  now = () => new Date(),
  record_job = true
} = {}) {
  const allocatedJobId = job_id || defaultExternalAgentJobId(now());
  const policy = buildExternalGatewayPolicy({ gateway_type, gateway_name, action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH, sandbox_root, requested_paths, task });
  if (!policy.ok) return makeBase({ job_id: allocatedJobId, reason: policy.reason, gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, timeout_ms });

  const runtimeApproval = gatewayRuntimeDependencyApproved(policy, { explicit_runtime_approval });
  if (!runtimeApproval.ok) return makeBase({ job_id: allocatedJobId, reason: runtimeApproval.reason, gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const runtimeCommand = normalizeRuntimeCommand(policy.gateway_type, command);
  if (!runtimeCommand) return makeBase({ job_id: allocatedJobId, reason: 'gateway_runtime_command_not_allowed', gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const runtimeArgs = args || buildAdapterArgs({ task: policy.task_preview, candidate_patch_path: 'candidate.patch', requested_paths: policy.requested_paths });
  if (!argsAreAllowed(runtimeArgs)) return makeBase({ job_id: allocatedJobId, reason: 'gateway_runtime_args_not_allowed', gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const cwd = ensureSandboxDir(rootDir, policy.sandbox_root);
  if (!cwd) return makeBase({ job_id: allocatedJobId, reason: 'sandbox_root_not_allowed', gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const started = now();
  if (record_job) {
    writeExternalAgentJob(rootDir, {
      job_id: allocatedJobId,
      status: 'running',
      approval_id,
      gateway_type: policy.gateway_type,
      gateway_name: policy.gateway_name,
      sandbox_root: policy.sandbox_root,
      candidate_patch_path: policy.candidate_patch_path,
      task_preview: policy.task_preview,
      started_at: started.toISOString(),
      updated_at: started.toISOString(),
      execution_connected: true,
      real_gateway_process_started: true,
      commands_executed: [[runtimeCommand, ...runtimeArgs].join(' ')],
      next_action: 'external_agent_candidate_patch_running'
    });
  }
  const result = spawn(runtimeCommand, runtimeArgs, {
    cwd,
    env: { PATH: env.PATH, HOME: env.HOME, CI: env.CI },
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 128
  });
  const finished = now();
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const candidateAbs = path.join(cwd, 'candidate.patch');
  const candidateExists = fs.existsSync(candidateAbs);
  const ok = exitCode === 0 && !timedOut && candidateExists;
  const adapterResult = makeBase({
    ok,
    reason: timedOut ? 'gateway_runtime_timeout' : ok ? null : exitCode === 0 ? 'candidate_patch_missing' : 'gateway_runtime_failed',
    job_id: allocatedJobId,
    gateway_type: policy.gateway_type,
    gateway_name: policy.gateway_name,
    sandbox_root: policy.sandbox_root,
    candidate_patch_path: policy.candidate_patch_path,
    command_preview: [runtimeCommand, ...runtimeArgs].join(' '),
    exit_code: exitCode,
    stdout_preview: redact(result.stdout || ''),
    stderr_preview: redact(result.stderr || result.error?.message || ''),
    duration_ms: Math.max(0, finished.getTime() - started.getTime()),
    timeout_ms,
    execution_connected: true,
    real_gateway_process_started: true,
    files_modified: candidateExists ? [policy.candidate_patch_path] : [],
    repository_files_modified: [],
    next_action: ok ? 'preview_candidate_patch_before_apply' : 'fix_external_agent_adapter_failure'
  });
  if (!record_job) return adapterResult;
  return writeAdapterJob(rootDir, adapterResult, {
    approval_id,
    task_preview: policy.task_preview,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    status: ok ? 'completed' : 'failed'
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ALLOWED_RUNTIME_COMMANDS,
  FORBIDDEN_ARGS,
  redact,
  normalizeRuntimeCommand,
  buildAdapterArgs,
  argsAreAllowed,
  runExternalAgentCandidatePatch
};
