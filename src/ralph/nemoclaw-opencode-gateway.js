const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildNemoClawPolicy, sanitizeGatewayResult, NEMOCLAW_ACTIONS, redactText } = require('./nemoclaw-policy');
const { defaultExternalAgentJobId, writeExternalAgentJob } = require('./external-agent-jobs');

const DEFAULT_TIMEOUT_MS = 60000;
const NEMOCLAW_COMMAND = 'nemoclaw';
const NEMOCLAW_SANDBOX_ENV = 'NEMOCLAW_SANDBOX_NAME';
const UNSUPPORTED_CANDIDATE_PATCH_REASON = 'nemoclaw_candidate_patch_command_unavailable';

function ensureSandboxDir(rootDir, sandboxRoot) {
  const resolved = path.resolve(rootDir, sandboxRoot);
  const expectedPrefix = path.resolve(rootDir, '.ralph', 'tmp');
  if (!resolved.startsWith(expectedPrefix)) return null;
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function buildNemoClawArgs({ task, candidate_patch_path, requested_paths }) {
  return [
    'opencode',
    'run-candidate-patch',
    '--candidate-patch',
    'candidate.patch',
    '--requested-paths',
    requested_paths.join(','),
    '--task',
    task
  ];
}

function runtimeInstalled(command = NEMOCLAW_COMMAND, { spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(command, ['--version'], { encoding: 'utf8', env: { PATH: env.PATH, HOME: env.HOME }, timeout: 5000, maxBuffer: 1024 * 8 });
  return !(result.error && result.error.code === 'ENOENT');
}

function commandPreview(command, args = []) {
  return [command, ...args].map((item) => redactText(item, 120)).join(' ');
}

function boundedOutput(value, maxLength = 600) {
  return redactText(String(value || ''), maxLength);
}

function candidatePatchCommandAvailable(command = NEMOCLAW_COMMAND, { spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(command, ['opencode', 'run-candidate-patch', '--help'], {
    encoding: 'utf8',
    env: { PATH: env.PATH, HOME: env.HOME },
    timeout: 5000,
    maxBuffer: 1024 * 16
  });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error && result.error.code === 'ENOENT') return { ok: false, reason: 'nemoclaw_runtime_not_installed', stdout_preview: '', stderr_preview: boundedOutput(result.error.message || '') };
  if (/Unknown command:\s*opencode/i.test(text) || /Usage:\s*nemoclaw\s+opencode\s+connect/i.test(text)) {
    return { ok: false, reason: UNSUPPORTED_CANDIDATE_PATCH_REASON, stdout_preview: boundedOutput(result.stdout || ''), stderr_preview: boundedOutput(result.stderr || '') };
  }
  return { ok: result.status === 0, reason: result.status === 0 ? null : UNSUPPORTED_CANDIDATE_PATCH_REASON, stdout_preview: boundedOutput(result.stdout || ''), stderr_preview: boundedOutput(result.stderr || '') };
}

function makeBase(overrides = {}) {
  return {
    ok: false,
    stage: 'nemoclaw_opencode_gateway',
    reason: null,
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw',
    job_id: null,
    approval_id: null,
    sandbox_root: null,
    candidate_patch_path: null,
    command_preview: null,
    exit_code: null,
    stdout_preview: '',
    stderr_preview: '',
    duration_ms: 0,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    runtime_installed: false,
    candidate_patch_command_available: false,
    execution_connected: false,
    real_gateway_process_started: false,
    opencode_execution_started: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false,
    raw_log_allowed: false,
    secret_display_allowed: false,
    secret_persistence_allowed: false,
    bounded_metadata_only: true,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    job: null,
    next_action: 'fix_nemoclaw_gateway_failure',
    ...overrides
  };
}

function writeGatewayJob(rootDir, result, { task_preview, started_at, finished_at, status }) {
  if (!result.job_id) return result;
  const written = writeExternalAgentJob(rootDir, {
    job_id: result.job_id,
    status,
    approval_id: result.approval_id,
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw',
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
    commands_executed: result.commands_executed,
    files_modified: result.files_modified,
    next_action: result.next_action
  });
  return { ...result, job: written.ok ? written.summary : null };
}

function runNemoClawOpenCodeCandidatePatch({
  rootDir = process.cwd(),
  approval_id = null,
  job_id,
  sandbox_root,
  requested_paths = [],
  task,
  command = NEMOCLAW_COMMAND,
  args = null,
  env = process.env,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  spawn = spawnSync,
  now = () => new Date(),
  record_job = true
} = {}) {
  const allocatedJobId = job_id || defaultExternalAgentJobId(now());
  const runtimeArgs = args || buildNemoClawArgs({ task, candidate_patch_path: 'candidate.patch', requested_paths });
  const policy = buildNemoClawPolicy({ action: NEMOCLAW_ACTIONS.RUN_CANDIDATE_PATCH, sandbox_root, requested_paths, task, args: runtimeArgs });
  if (!policy.ok) return makeBase({ job_id: allocatedJobId, approval_id, reason: policy.reason, sandbox_root, timeout_ms });
  if (command !== NEMOCLAW_COMMAND) return makeBase({ job_id: allocatedJobId, approval_id, reason: 'nemoclaw_command_required', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const cwd = ensureSandboxDir(rootDir, policy.sandbox_root);
  if (!cwd) return makeBase({ job_id: allocatedJobId, approval_id, reason: 'sandbox_root_not_allowed', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });
  try { fs.rmSync(path.join(cwd, 'candidate.patch'), { force: true }); } catch {}

  const installed = runtimeInstalled(command, { spawn, env });
  if (!installed) return makeBase({ job_id: allocatedJobId, approval_id, reason: 'nemoclaw_runtime_not_installed', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, runtime_installed: false, timeout_ms, next_action: 'install_nemoclaw_or_use_approved_dev_only_direct_path' });

  const availability = candidatePatchCommandAvailable(command, { spawn, env });
  if (!availability.ok) {
    return makeBase({
      job_id: allocatedJobId,
      approval_id,
      reason: availability.reason || UNSUPPORTED_CANDIDATE_PATCH_REASON,
      sandbox_root: policy.sandbox_root,
      candidate_patch_path: policy.candidate_patch_path,
      command_preview: commandPreview(command, runtimeArgs),
      stdout_preview: availability.stdout_preview || '',
      stderr_preview: availability.stderr_preview || '',
      runtime_installed: true,
      candidate_patch_command_available: false,
      execution_connected: false,
      timeout_ms,
      next_action: 'implement_supported_nemoclaw_candidate_patch_adapter_or_use_approved_dev_only_direct_path'
    });
  }

  const started = now();
  if (record_job) {
    writeExternalAgentJob(rootDir, {
      job_id: allocatedJobId,
      status: 'running',
      approval_id,
      gateway_type: 'nemoclaw',
      gateway_name: 'nemoclaw',
      sandbox_root: policy.sandbox_root,
      candidate_patch_path: policy.candidate_patch_path,
      task_preview: policy.task_preview,
      started_at: started.toISOString(),
      updated_at: started.toISOString(),
      execution_connected: true,
      real_gateway_process_started: true,
      commands_executed: [commandPreview(command, runtimeArgs)],
      next_action: 'nemoclaw_opencode_candidate_patch_running'
    });
  }

  const result = spawn(command, runtimeArgs, {
    cwd,
    env: { PATH: env.PATH, HOME: env.HOME, CI: env.CI, [NEMOCLAW_SANDBOX_ENV]: env[NEMOCLAW_SANDBOX_ENV] },
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
  const raw = makeBase({
    ok,
    reason: timedOut ? 'nemoclaw_runtime_timeout' : ok ? null : exitCode === 0 ? 'candidate_patch_missing' : 'nemoclaw_runtime_failed',
    job_id: allocatedJobId,
    approval_id,
    sandbox_root: policy.sandbox_root,
    candidate_patch_path: policy.candidate_patch_path,
    command_preview: commandPreview(command, runtimeArgs),
    exit_code: exitCode,
    stdout_preview: result.stdout || '',
    stderr_preview: result.stderr || result.error?.message || '',
    duration_ms: Math.max(0, finished.getTime() - started.getTime()),
    timeout_ms,
    runtime_installed: true,
    candidate_patch_command_available: true,
    execution_connected: true,
    real_gateway_process_started: true,
    opencode_execution_started: true,
    commands_executed: [commandPreview(command, runtimeArgs)],
    files_modified: candidateExists ? [policy.candidate_patch_path] : [],
    repository_files_modified: [],
    next_action: ok ? 'preview_candidate_patch_before_apply' : 'fix_nemoclaw_gateway_failure'
  });
  const safe = sanitizeGatewayResult(raw, policy);
  if (!record_job) return safe;
  return writeGatewayJob(rootDir, safe, {
    task_preview: policy.task_preview,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    status: ok ? 'completed' : 'failed'
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  NEMOCLAW_COMMAND,
  NEMOCLAW_SANDBOX_ENV,
  UNSUPPORTED_CANDIDATE_PATCH_REASON,
  ensureSandboxDir,
  buildNemoClawArgs,
  runtimeInstalled,
  candidatePatchCommandAvailable,
  commandPreview,
  runNemoClawOpenCodeCandidatePatch
};
