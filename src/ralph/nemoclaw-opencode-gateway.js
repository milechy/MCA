const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildNemoClawPolicy, sanitizeGatewayResult, NEMOCLAW_ACTIONS, redactText } = require('./nemoclaw-policy');
const { defaultExternalAgentJobId, writeExternalAgentJob } = require('./external-agent-jobs');

const DEFAULT_TIMEOUT_MS = 60000;
const NEMOCLAW_COMMAND = 'nemoclaw';
const OPENSHELL_COMMAND = 'openshell';
const NEMOCLAW_SANDBOX_ENV = 'NEMOCLAW_SANDBOX_NAME';
const DEFAULT_NEMOCLAW_SANDBOX = 'mca-ralph';
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

function candidatePatchCommandAvailable(command = OPENSHELL_COMMAND, { spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(command, ['sandbox', 'exec', '--help'], {
    encoding: 'utf8',
    env: { PATH: env.PATH, HOME: env.HOME },
    timeout: 5000,
    maxBuffer: 1024 * 16
  });
  if (result.error && result.error.code === 'ENOENT') return { ok: false, reason: 'openshell_runtime_not_installed', stdout_preview: '', stderr_preview: boundedOutput(result.error.message || '') };
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/Execute a command in a running sandbox/i.test(text) || /sandbox exec/i.test(text)) return { ok: true, reason: null, stdout_preview: boundedOutput(result.stdout || ''), stderr_preview: boundedOutput(result.stderr || '') };
  return { ok: false, reason: UNSUPPORTED_CANDIDATE_PATCH_REASON, stdout_preview: boundedOutput(result.stdout || ''), stderr_preview: boundedOutput(result.stderr || '') };
}

function sandboxNameFromEnv(env = process.env) {
  return String(env[NEMOCLAW_SANDBOX_ENV] || env.OPENSHELL_SANDBOX_NAME || DEFAULT_NEMOCLAW_SANDBOX).trim() || DEFAULT_NEMOCLAW_SANDBOX;
}

function buildOpenClawCandidatePatchPrompt({ task, requested_paths = [] }) {
  const paths = requested_paths.length ? requested_paths.join(', ') : '(no requested paths supplied)';
  return [
    'You are OpenCode running inside a NemoClaw/OpenShell sandbox under Ralph control.',
    'Create exactly one file named candidate.patch in the current working directory.',
    'The file must be a unified git diff only. Do not apply the patch. Do not commit. Do not push. Do not create a PR. Do not deploy. Do not run migrations. Do not print secrets or raw logs.',
    `Requested paths: ${paths}`,
    `Task: ${String(task || '').slice(0, 4000)}`,
    'When finished, reply with a short bounded status only.'
  ].join('\n');
}

function buildOpenShellAgentArgs({ sandbox_name, task, requested_paths = [], timeout_ms = DEFAULT_TIMEOUT_MS }) {
  const seconds = String(Math.max(1, Math.ceil(timeout_ms / 1000)));
  return [
    'sandbox', 'exec', '-n', sandbox_name,
    '--workdir', '/sandbox',
    '--timeout', seconds,
    '--no-tty',
    '--',
    'openclaw', 'agent',
    '--message', buildOpenClawCandidatePatchPrompt({ task, requested_paths }),
    '--json',
    '--timeout', seconds
  ];
}

function buildOpenShellCatArgs({ sandbox_name }) {
  return ['sandbox', 'exec', '-n', sandbox_name, '--workdir', '/sandbox', '--timeout', '30', '--no-tty', '--', 'cat', 'candidate.patch'];
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
  const policyArgs = args || buildNemoClawArgs({ task, candidate_patch_path: 'candidate.patch', requested_paths });
  const policy = buildNemoClawPolicy({ action: NEMOCLAW_ACTIONS.RUN_CANDIDATE_PATCH, sandbox_root, requested_paths, task, args: policyArgs });
  if (!policy.ok) return makeBase({ job_id: allocatedJobId, approval_id, reason: policy.reason, sandbox_root, timeout_ms });
  if (command !== NEMOCLAW_COMMAND) return makeBase({ job_id: allocatedJobId, approval_id, reason: 'nemoclaw_command_required', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });

  const cwd = ensureSandboxDir(rootDir, policy.sandbox_root);
  if (!cwd) return makeBase({ job_id: allocatedJobId, approval_id, reason: 'sandbox_root_not_allowed', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, timeout_ms });
  const candidateAbs = path.join(cwd, 'candidate.patch');
  try { fs.rmSync(candidateAbs, { force: true }); } catch {}

  const installed = runtimeInstalled(command, { spawn, env });
  if (!installed) return makeBase({ job_id: allocatedJobId, approval_id, reason: 'nemoclaw_runtime_not_installed', sandbox_root: policy.sandbox_root, candidate_patch_path: policy.candidate_patch_path, runtime_installed: false, timeout_ms, next_action: 'install_nemoclaw_or_use_approved_dev_only_direct_path' });

  const availability = candidatePatchCommandAvailable(OPENSHELL_COMMAND, { spawn, env });
  if (!availability.ok) {
    return makeBase({
      job_id: allocatedJobId,
      approval_id,
      reason: availability.reason || UNSUPPORTED_CANDIDATE_PATCH_REASON,
      sandbox_root: policy.sandbox_root,
      candidate_patch_path: policy.candidate_patch_path,
      stdout_preview: availability.stdout_preview || '',
      stderr_preview: availability.stderr_preview || '',
      runtime_installed: true,
      candidate_patch_command_available: false,
      execution_connected: false,
      timeout_ms,
      next_action: 'install_openshell_or_configure_nemoclaw_sandbox'
    });
  }

  const sandboxName = sandboxNameFromEnv(env);
  const agentArgs = buildOpenShellAgentArgs({ sandbox_name: sandboxName, task, requested_paths, timeout_ms });
  const catArgs = buildOpenShellCatArgs({ sandbox_name: sandboxName });
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
      commands_executed: [commandPreview(OPENSHELL_COMMAND, agentArgs), commandPreview(OPENSHELL_COMMAND, catArgs)],
      next_action: 'openshell_openclaw_candidate_patch_running'
    });
  }

  const runResult = spawn(OPENSHELL_COMMAND, agentArgs, {
    cwd,
    env: { PATH: env.PATH, HOME: env.HOME, CI: env.CI, OPENSHELL_GATEWAY: env.OPENSHELL_GATEWAY || 'nemoclaw' },
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 256
  });
  const catResult = spawn(OPENSHELL_COMMAND, catArgs, {
    cwd,
    env: { PATH: env.PATH, HOME: env.HOME, CI: env.CI, OPENSHELL_GATEWAY: env.OPENSHELL_GATEWAY || 'nemoclaw' },
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 256
  });
  const finished = now();
  const timedOut = (runResult.error && runResult.error.code === 'ETIMEDOUT') || (catResult.error && catResult.error.code === 'ETIMEDOUT');
  const exitCode = typeof runResult.status === 'number' ? runResult.status : null;
  const catExitCode = typeof catResult.status === 'number' ? catResult.status : null;
  const patchText = String(catResult.stdout || '');
  const patchLooksValid = /^diff --git /m.test(patchText) && !/^```/m.test(patchText.trim());
  if (patchLooksValid) fs.writeFileSync(candidateAbs, patchText);
  const ok = exitCode === 0 && catExitCode === 0 && !timedOut && patchLooksValid;
  const raw = makeBase({
    ok,
    reason: timedOut ? 'nemoclaw_runtime_timeout' : ok ? null : catExitCode !== 0 ? 'candidate_patch_missing' : !patchLooksValid ? 'candidate_patch_invalid' : 'nemoclaw_runtime_failed',
    job_id: allocatedJobId,
    approval_id,
    sandbox_root: policy.sandbox_root,
    candidate_patch_path: policy.candidate_patch_path,
    command_preview: commandPreview(OPENSHELL_COMMAND, agentArgs),
    exit_code: exitCode,
    stdout_preview: `${runResult.stdout || ''}\n${catResult.stdout || ''}`,
    stderr_preview: `${runResult.stderr || runResult.error?.message || ''}\n${catResult.stderr || catResult.error?.message || ''}`,
    duration_ms: Math.max(0, finished.getTime() - started.getTime()),
    timeout_ms,
    runtime_installed: true,
    candidate_patch_command_available: true,
    execution_connected: true,
    real_gateway_process_started: true,
    opencode_execution_started: true,
    commands_executed: [commandPreview(OPENSHELL_COMMAND, agentArgs), commandPreview(OPENSHELL_COMMAND, catArgs)],
    files_modified: ok ? [policy.candidate_patch_path] : [],
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
  OPENSHELL_COMMAND,
  NEMOCLAW_SANDBOX_ENV,
  DEFAULT_NEMOCLAW_SANDBOX,
  UNSUPPORTED_CANDIDATE_PATCH_REASON,
  ensureSandboxDir,
  buildNemoClawArgs,
  runtimeInstalled,
  candidatePatchCommandAvailable,
  sandboxNameFromEnv,
  buildOpenClawCandidatePatchPrompt,
  buildOpenShellAgentArgs,
  buildOpenShellCatArgs,
  commandPreview,
  runNemoClawOpenCodeCandidatePatch
};
