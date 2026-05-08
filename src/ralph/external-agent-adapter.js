const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildExternalGatewayPolicy, gatewayRuntimeDependencyApproved, GATEWAY_ACTIONS } = require('./external-agent-gateway');

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
    next_action: 'fix_external_agent_adapter_failure',
    ...overrides
  };
}

function runExternalAgentCandidatePatch({
  rootDir = process.cwd(),
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
  now = () => new Date()
} = {}) {
  const policy = buildExternalGatewayPolicy({ gateway_type, gateway_name, action: GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH, sandbox_root, requested_paths, task });
  if (!policy.ok) return makeBase({ reason: policy.reason, gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, timeout_ms });

  const runtimeApproval = gatewayRuntimeDependencyApproved(policy, { explicit_runtime_approval });
  if (!runtimeApproval.ok) return makeBase({ reason: runtimeApproval.reason, gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const runtimeCommand = normalizeRuntimeCommand(policy.gateway_type, command);
  if (!runtimeCommand) return makeBase({ reason: 'gateway_runtime_command_not_allowed', gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const runtimeArgs = args || buildAdapterArgs({ task: policy.task_preview, candidate_patch_path: 'candidate.patch', requested_paths: policy.requested_paths });
  if (!argsAreAllowed(runtimeArgs)) return makeBase({ reason: 'gateway_runtime_args_not_allowed', gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const cwd = ensureSandboxDir(rootDir, policy.sandbox_root);
  if (!cwd) return makeBase({ reason: 'sandbox_root_not_allowed', gateway_type: policy.gateway_type, gateway_name: policy.gateway_name, sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const started = now();
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

  return makeBase({
    ok,
    reason: timedOut ? 'gateway_runtime_timeout' : ok ? null : exitCode === 0 ? 'candidate_patch_missing' : 'gateway_runtime_failed',
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
