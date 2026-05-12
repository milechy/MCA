const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildRequestedFileContext,
  buildOpenClawDiffOnlyPrompt,
  extractUnifiedDiffFromText,
  validPatchText,
  validateCandidatePatchAgainstRepository
} = require('./nemoclaw-opencode-gateway');

const OPENCODE_COMMAND = 'opencode';
const DEFAULT_MODEL = 'openrouter/moonshotai/kimi-k2';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PATCH_SOURCE = 'opencode_kimi_via_openrouter';
const MEDIATOR = 'opencode-direct';
const RUNTIME_MODE = 'opencode-kimi-direct';

const TRANSIENT_PROVIDER_PATTERNS = /rate limit|ratelimit|too many requests|quota exceeded|resource exhausted|429|503|gateway timeout|upstream/i;

function oneLine(value, maxLength = 600) {
  const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..') || /\0/.test(normalized)) return null;
  return normalized;
}

const ALLOWED_SANDBOX_PREFIXES = ['.ralph/sandboxes/', '.ralph/tmp/'];

function ensureSandboxRoot(rootDir, sandbox_root) {
  const safe = safeRelativePath(sandbox_root || '');
  if (!safe || !ALLOWED_SANDBOX_PREFIXES.some((prefix) => safe.startsWith(prefix))) {
    return { ok: false, reason: 'opencode_kimi_sandbox_root_not_allowed' };
  }
  const absolute = path.resolve(rootDir, safe);
  fs.mkdirSync(absolute, { recursive: true });
  return { ok: true, reason: null, sandbox_root: safe, absolute };
}

function safeEnv(env) {
  const apiKey = env.OPENROUTER_API_KEY || env.KIMI_API_KEY || '';
  return {
    PATH: env.PATH || '',
    HOME: env.HOME || '',
    TMPDIR: env.TMPDIR || '',
    CI: env.CI || '',
    OPENROUTER_API_KEY: apiKey,
    OPENCODE_DISABLE_TELEMETRY: '1'
  };
}

function resolveModel(env) {
  const raw = String(env.RALPH_OPENCODE_KIMI_MODEL || env.OPENCODE_MODEL || DEFAULT_MODEL).trim();
  if (!raw || /[\s;|&`$<>]/.test(raw)) return DEFAULT_MODEL;
  return raw;
}

function buildPrompt({ task, requested_paths, rootDir }) {
  const file_context = buildRequestedFileContext({ rootDir, requested_paths });
  const lines = buildOpenClawDiffOnlyPrompt({ task, requested_paths, file_context }).split('\n');
  lines.splice(1, 0, 'You are Ralph execution provider (Kimi K2 via OpenRouter through OpenCode).');
  return lines.join('\n');
}

function commandPreview(command, args) {
  return oneLine([command, ...args].join(' '), 240);
}

function makeBase(overrides = {}) {
  return {
    ok: false,
    stage: 'opencode_kimi_dispatcher',
    reason: null,
    mediator: MEDIATOR,
    opencode_runtime_mode: RUNTIME_MODE,
    gateway_type: 'opencode-kimi',
    gateway_name: 'opencode-kimi-direct',
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
    patch_source: null,
    patch_validation: null,
    next_action: 'fix_opencode_kimi_dispatcher_failure',
    ...overrides
  };
}

function classifyFailure({ timedOut, exitCode, patchLooksValid, patchValidation, output, missingKey }) {
  if (missingKey) return 'opencode_kimi_api_key_missing';
  if (timedOut) return 'opencode_kimi_runtime_timeout';
  if (output && TRANSIENT_PROVIDER_PATTERNS.test(output)) return 'provider_rate_limited';
  if (!patchLooksValid) return 'candidate_patch_missing';
  if (patchValidation && patchValidation.ok === false) return patchValidation.reason || 'candidate_patch_invalid';
  if (exitCode !== 0) return 'opencode_kimi_runtime_failed';
  return null;
}

function nextActionForFailure(reason) {
  switch (reason) {
    case 'opencode_kimi_api_key_missing':
      return 'set_openrouter_api_key_or_kimi_api_key_env';
    case 'opencode_kimi_runtime_timeout':
      return 'retry_or_increase_opencode_kimi_timeout';
    case 'provider_rate_limited':
      return 'retry_after_provider_rate_limit';
    case 'candidate_patch_missing':
    case 'candidate_patch_invalid':
      return 'retry_or_fallback_after_invalid_candidate_patch';
    default:
      return 'fix_opencode_kimi_dispatcher_failure';
  }
}

function runtimeInstalled(command = OPENCODE_COMMAND, { spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(command, ['--version'], { encoding: 'utf8', env: { PATH: env.PATH, HOME: env.HOME }, timeout: 5000, maxBuffer: 1024 * 8 });
  if (result.error && result.error.code === 'ENOENT') return false;
  return result.status === 0;
}

function dispatchOpenCodeKimi({
  rootDir = process.cwd(),
  story = {},
  approval_id = null,
  job_id = null,
  sandbox_root,
  task = '',
  requested_paths = [],
  command = OPENCODE_COMMAND,
  env = process.env,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  spawn = spawnSync,
  now = () => new Date()
} = {}) {
  const started = now();
  const policy = ensureSandboxRoot(rootDir, sandbox_root);
  if (!policy.ok) {
    return makeBase({ ok: false, reason: policy.reason, job_id, approval_id, sandbox_root, timeout_ms, next_action: 'fix_opencode_kimi_sandbox_root' });
  }

  const candidate_patch_path_relative = `${policy.sandbox_root}/candidate.patch`;
  const candidate_patch_abs = path.resolve(rootDir, candidate_patch_path_relative);

  const installed = runtimeInstalled(command, { spawn, env });
  if (!installed) {
    return makeBase({ ok: false, reason: 'opencode_runtime_not_installed', job_id, approval_id, sandbox_root: policy.sandbox_root, candidate_patch_path: candidate_patch_path_relative, timeout_ms, next_action: 'install_opencode_cli_v1_or_newer' });
  }

  const scrubbedEnv = safeEnv(env);
  if (!scrubbedEnv.OPENROUTER_API_KEY) {
    return makeBase({ ok: false, reason: 'opencode_kimi_api_key_missing', job_id, approval_id, sandbox_root: policy.sandbox_root, candidate_patch_path: candidate_patch_path_relative, runtime_installed: true, timeout_ms, next_action: nextActionForFailure('opencode_kimi_api_key_missing') });
  }

  const model = resolveModel(env);
  const prompt = buildPrompt({ task, requested_paths, rootDir });
  const args = ['run', '--model', model, '--format', 'json', '--dir', rootDir, prompt];
  const commands = [commandPreview(command, args)];

  const result = spawn(command, args, {
    cwd: rootDir,
    env: scrubbedEnv,
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 1024
  });
  const finished = now();

  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || (result.error && result.error.message) || '');
  const output = `${stdout}\n${stderr}`;

  const patchText = extractUnifiedDiffFromText(stdout);
  const patchLooksValid = validPatchText(patchText);
  const patchValidation = patchLooksValid
    ? validateCandidatePatchAgainstRepository({ rootDir, patchText, requested_paths })
    : { ok: false, reason: 'candidate_patch_invalid' };

  if (patchLooksValid && patchValidation.ok) {
    fs.writeFileSync(candidate_patch_abs, patchText, 'utf8');
  }

  const ok = !timedOut && exitCode === 0 && patchLooksValid && patchValidation.ok;
  const reason = ok ? null : classifyFailure({ timedOut, exitCode, patchLooksValid, patchValidation, output, missingKey: false });
  const patchSource = ok ? PATCH_SOURCE : null;

  return makeBase({
    ok,
    reason,
    job_id,
    approval_id,
    sandbox_root: policy.sandbox_root,
    candidate_patch_path: candidate_patch_path_relative,
    command_preview: commands[0],
    exit_code: exitCode,
    stdout_preview: oneLine(stdout, 600),
    stderr_preview: oneLine(stderr, 600),
    duration_ms: Math.max(0, finished.getTime() - started.getTime()),
    timeout_ms,
    runtime_installed: true,
    candidate_patch_command_available: true,
    execution_connected: true,
    real_gateway_process_started: true,
    opencode_execution_started: true,
    patch_source: patchSource,
    patch_validation: patchValidation,
    commands_executed: commands,
    files_modified: ok ? [candidate_patch_path_relative] : [],
    repository_files_modified: [],
    next_action: ok ? 'preview_candidate_patch_before_apply' : nextActionForFailure(reason)
  });
}

module.exports = {
  OPENCODE_COMMAND,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  PATCH_SOURCE,
  MEDIATOR,
  RUNTIME_MODE,
  resolveModel,
  safeEnv,
  buildPrompt,
  classifyFailure,
  nextActionForFailure,
  runtimeInstalled,
  dispatchOpenCodeKimi
};
