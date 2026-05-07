const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OPENCODE_SANDBOX_ENV } = require('./opencode-sandbox-preflight');
const { assertSandboxLocalPath } = require('./opencode-sandbox-runner');

const DEFAULT_TIMEOUT_MS = 5000;
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

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function commandPreview(command, args = []) {
  return [command, ...args].map((part) => oneLine(part, 80)).join(' ');
}

function commandIsSafe(command, args = []) {
  if (!command || typeof command !== 'string') return false;
  if (/[;&|`$<>]/.test(command)) return false;
  if (command.includes('..')) return false;
  if (!Array.isArray(args)) return false;
  if (args.some((arg) => /[;&|`$<>]/.test(String(arg)) || String(arg).includes('..'))) return false;

  if (command === 'opencode') {
    return args.length === 1 && args[0] === '--version';
  }

  if (command === process.execPath || command === 'node') {
    return args.length === 1 && String(args[0]).endsWith('opencode-version-double.js') && !String(args[0]).includes('..');
  }

  return false;
}

function makeBlockedResult(preflight, reason, extra = {}) {
  const now = new Date().toISOString();
  return {
    ok: false,
    stage: 'opencode_real_sandbox_smoke',
    reason,
    runner: 'real_opencode_sandbox_smoke',
    approval_id: preflight?.approval_id || null,
    sandbox_root: preflight?.sandbox_root || null,
    cwd: null,
    command_preview: null,
    exit_code: null,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    timeout_ms: extra.timeout_ms || DEFAULT_TIMEOUT_MS,
    stdout_preview: '',
    stderr_preview: '',
    stdout_length: 0,
    stderr_length: 0,
    execution_connected: false,
    opencode_execution_started: false,
    real_opencode_process_started: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    post_git_status_clean: extra.post_git_status_clean ?? null,
    next_action: 'fix_real_opencode_smoke_preflight'
  };
}

function runGitStatusClean(rootDir) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
  return result.status === 0 && String(result.stdout || '').trim() === '';
}

function runRealOpenCodeSandboxSmoke(preflight, { rootDir = process.cwd(), command = 'opencode', args = ['--version'], env = process.env, timeout_ms = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  if (!preflight || preflight.ok !== true || preflight.start_allowed !== true) {
    return makeBlockedResult(preflight, preflight?.reason || 'preflight_required', { timeout_ms });
  }

  if (env[OPENCODE_SANDBOX_ENV] !== 'true') {
    return makeBlockedResult(preflight, 'opencode_sandbox_env_not_enabled', { timeout_ms });
  }

  if (!commandIsSafe(command, args)) {
    return makeBlockedResult(preflight, 'opencode_command_not_allowed', { timeout_ms });
  }

  const sandboxCwd = path.resolve(rootDir, preflight.sandbox_root);
  if (!assertSandboxLocalPath(rootDir, preflight.sandbox_root, sandboxCwd)) {
    return makeBlockedResult(preflight, 'sandbox_cwd_not_allowed', { timeout_ms });
  }

  fs.mkdirSync(sandboxCwd, { recursive: true });
  const startedAt = now().toISOString();
  const result = spawnSync(command, args, {
    cwd: sandboxCwd,
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      [OPENCODE_SANDBOX_ENV]: env[OPENCODE_SANDBOX_ENV]
    },
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 32
  });
  const finishedAt = now().toISOString();
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  const postGitStatusClean = runGitStatusClean(rootDir);
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const ok = exitCode === 0 && !timedOut && postGitStatusClean;

  return {
    ok,
    stage: 'opencode_real_sandbox_smoke',
    reason: ok ? null : timedOut ? 'opencode_smoke_timeout' : postGitStatusClean ? 'opencode_smoke_failed' : 'post_git_status_dirty',
    runner: 'real_opencode_sandbox_smoke',
    approval_id: preflight.approval_id,
    sandbox_root: preflight.sandbox_root,
    cwd: preflight.sandbox_root,
    command_preview: commandPreview(command, args),
    exit_code: exitCode,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    timeout_ms,
    stdout_preview: oneLine(stdout),
    stderr_preview: oneLine(stderr),
    stdout_length: stdout.length,
    stderr_length: stderr.length,
    execution_connected: true,
    opencode_execution_started: true,
    real_opencode_process_started: true,
    commands_executed: [commandPreview(command, args)],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    post_git_status_clean: postGitStatusClean,
    next_action: ok ? 'review_real_opencode_smoke_then_consider_phase13_patch_preview' : 'fix_real_opencode_smoke_failure'
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_PREVIEW_CHARS,
  oneLine,
  durationMs,
  commandPreview,
  commandIsSafe,
  runRealOpenCodeSandboxSmoke
};
