const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OPENCODE_SANDBOX_ENV } = require('./opencode-sandbox-preflight');
const { assertSandboxLocalPath } = require('./opencode-sandbox-runner');
const { previewOpenCodeCandidatePatch } = require('./opencode-patch-preview');
const { buildOpenCodeRunInvocation } = require('./opencode-real-adapter');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TASK_CHARS = 1000;
const MAX_PREVIEW_CHARS = 240;
const SECRET_LIKE_PATTERN = /(?:\b\d{8,}:[A-Za-z0-9_-]{20,}\b|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})/g;

function oneLine(value, maxLength = MAX_PREVIEW_CHARS) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SECRET_LIKE_PATTERN, '<redacted>');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeTask(task) {
  return oneLine(task, MAX_TASK_CHARS);
}

function commandPreview(command, args = []) {
  return [command, ...args].map((part) => oneLine(part, 120)).join(' ');
}

function commandIsAllowed(command, args = []) {
  if (!command || typeof command !== 'string') return false;
  if (/[;&|`$<>]/.test(command) || command.includes('..')) return false;
  if (!Array.isArray(args)) return false;
  if (args.some((arg) => /[;&|`$<>]/.test(String(arg)) || String(arg).includes('..'))) return false;

  if (command === 'opencode') {
    if (!(args.length >= 1 && args[0] === 'run' && args.includes('--diff-only'))) return false;
    if (args.includes('--output')) return args.includes('candidate.patch');
    return true;
  }

  if (command === process.execPath || command === 'node') {
    return args.length === 1 && String(args[0]).endsWith('opencode-candidate-patch-double.js');
  }

  return false;
}

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function makeBlockedResult(preflight, reason, extra = {}) {
  const now = new Date().toISOString();
  return {
    ok: false,
    stage: 'opencode_run_candidate_patch',
    reason,
    approval_id: preflight?.approval_id || null,
    sandbox_root: preflight?.sandbox_root || null,
    task_preview: extra.task_preview || '',
    cwd: null,
    command_preview: null,
    exit_code: null,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    timeout_ms: extra.timeout_ms || DEFAULT_TIMEOUT_MS,
    stdout_preview: '',
    stderr_preview: '',
    candidate_patch_path: null,
    patch_preview: null,
    execution_connected: false,
    opencode_execution_started: false,
    real_opencode_process_started: false,
    apply_allowed: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_opencode_run_failure'
  };
}

function runOpenCodeCandidatePatch(preflight, { rootDir = process.cwd(), task, command, args, env = process.env, timeout_ms = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  const taskPreview = normalizeTask(task);
  if (!taskPreview) return makeBlockedResult(preflight, 'task_required', { task_preview: taskPreview, timeout_ms });
  if (!preflight || preflight.ok !== true || preflight.start_allowed !== true) return makeBlockedResult(preflight, preflight?.reason || 'preflight_required', { task_preview: taskPreview, timeout_ms });
  if (env[OPENCODE_SANDBOX_ENV] !== 'true') return makeBlockedResult(preflight, 'opencode_sandbox_env_not_enabled', { task_preview: taskPreview, timeout_ms });

  const invocation = command && args ? { ok: true, command, args } : buildOpenCodeRunInvocation({ task: taskPreview, env });
  if (!invocation.ok) return makeBlockedResult(preflight, invocation.reason, { task_preview: taskPreview, timeout_ms });
  const runCommand = invocation.command;
  const runArgs = invocation.args;
  if (!commandIsAllowed(runCommand, runArgs)) return makeBlockedResult(preflight, 'opencode_command_not_allowed', { task_preview: taskPreview, timeout_ms });

  const sandboxCwd = path.resolve(rootDir, preflight.sandbox_root);
  if (!assertSandboxLocalPath(rootDir, preflight.sandbox_root, sandboxCwd)) return makeBlockedResult(preflight, 'sandbox_cwd_not_allowed', { task_preview: taskPreview, timeout_ms });

  fs.mkdirSync(sandboxCwd, { recursive: true });
  const patchPath = path.join(sandboxCwd, 'candidate.patch');
  try { fs.rmSync(patchPath, { force: true }); } catch {}

  const startedAt = now().toISOString();
  const result = spawnSync(runCommand, runArgs, {
    cwd: sandboxCwd,
    env: { PATH: env.PATH, HOME: env.HOME, [OPENCODE_SANDBOX_ENV]: env[OPENCODE_SANDBOX_ENV] },
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 64
  });
  const finishedAt = now().toISOString();
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const preview = previewOpenCodeCandidatePatch({ rootDir, approval_id: preflight.approval_id, sandbox_root: preflight.sandbox_root, candidate_patch_path: patchPath });
  const ok = exitCode === 0 && !timedOut && preview.ok === true && preview.requires_approval === true;

  return {
    ok,
    stage: 'opencode_run_candidate_patch',
    reason: ok ? null : timedOut ? 'opencode_run_timeout' : exitCode !== 0 ? 'opencode_run_failed' : preview.reason || 'candidate_patch_not_ready',
    approval_id: preflight.approval_id,
    sandbox_root: preflight.sandbox_root,
    task_preview: taskPreview,
    cwd: preflight.sandbox_root,
    command_preview: commandPreview(runCommand, runArgs),
    exit_code: exitCode,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    timeout_ms,
    stdout_preview: oneLine(result.stdout || ''),
    stderr_preview: oneLine(result.stderr || result.error?.message || ''),
    candidate_patch_path: path.relative(rootDir, patchPath).replace(/\\/g, '/'),
    patch_preview: preview,
    execution_connected: true,
    opencode_execution_started: true,
    real_opencode_process_started: true,
    apply_allowed: false,
    commands_executed: [commandPreview(runCommand, runArgs)],
    files_modified: preview.ok ? [path.relative(rootDir, patchPath).replace(/\\/g, '/')] : [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: ok ? 'create_patch_preview_approval_then_apply_preflight' : 'fix_opencode_run_failure'
  };
}

module.exports = { DEFAULT_TIMEOUT_MS, normalizeTask, commandIsAllowed, commandPreview, runOpenCodeCandidatePatch };
