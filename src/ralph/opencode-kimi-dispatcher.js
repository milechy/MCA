const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  buildRequestedFileContext,
  buildOpenClawDiffOnlyPrompt,
  buildOpenClawCandidatePatchPrompt,
  extractUnifiedDiffFromText,
  validPatchText,
  validateCandidatePatchAgainstRepository
} = require('./nemoclaw-opencode-gateway');
const {
  createStoryWorktree,
  destroyStoryWorktree,
  diffStoryWorktree
} = require('./story-worktree');

const OPENCODE_COMMAND = 'opencode';
const DEFAULT_MODEL = 'openrouter/moonshotai/kimi-k2.6';
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

function buildWorktreePrompt({ task, requested_paths, rootDir }) {
  const file_context = buildRequestedFileContext({ rootDir, requested_paths });
  const paths = requested_paths.length ? requested_paths.join(', ') : '(no requested paths supplied)';
  return [
    'You are Ralph execution provider (Kimi K2 via OpenRouter through OpenCode).',
    'You are running inside an isolated git worktree owned by Ralph. Ralph will run `git diff` over the worktree after you finish, and the resulting unified diff IS the candidate patch.',
    'How to deliver your work:',
    '  - Modify or create files at the paths listed under "Requested paths" using normal write/edit tools.',
    '  - Do NOT write a file literally named "candidate.patch" or "candidate.diff" anywhere — that file would itself appear in the diff and be rejected.',
    '  - Do NOT print the diff to stdout; just leave the worktree in the desired final state.',
    '  - It is acceptable to create only a subset of the requested paths if the task does not need all of them.',
    'Hard constraints:',
    '  - Do NOT touch any path outside the explicit requested_paths.',
    '  - Do NOT run git, gh, npm publish, deploy, migration, or any push/merge/release command.',
    '  - Do NOT print secrets or raw environment values.',
    '  - Do NOT delete .git, .ralph, or anything under those directories.',
    '  - If the requested paths reference an existing file, treat the bounded file context below as the source of truth; do not invent contents you did not read.',
    `Requested paths: ${paths}`,
    `Task: ${String(task || '').slice(0, 4000)}`,
    file_context ? `Bounded file context:\n${file_context}` : 'Bounded file context: (none supplied)',
    'When you are done, simply end the session. Ralph will capture the diff.'
  ].join('\n');
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
  // Content checks come before transient-pattern matching so that a real path /
  // validation failure is not masked by an unrelated 429-looking substring that
  // happens to appear elsewhere in the bounded output preview.
  if (patchLooksValid && patchValidation && patchValidation.ok === false) return patchValidation.reason || 'candidate_patch_invalid';
  if (output && TRANSIENT_PROVIDER_PATTERNS.test(output)) return 'provider_rate_limited';
  if (!patchLooksValid) return 'candidate_patch_missing';
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

function worktreeDisabled(env = process.env) {
  return env.RALPH_OPENCODE_KIMI_DISABLE_WORKTREE === 'true' || env.RALPH_OPENCODE_KIMI_DISABLE_WORKTREE === '1';
}

function patchFromWorktree({ rootDir, sandbox_root, base_sha, spawn, env }) {
  const diff = diffStoryWorktree({ rootDir, sandbox_root, base_sha, spawn, env });
  if (!diff.ok) return { patchText: '', extractionMode: 'worktree', diff };
  const stripped = diff.patch_text.trim().length === 0 ? '' : diff.patch_text;
  return { patchText: stripped, extractionMode: 'worktree', diff };
}

function patchFromStdout({ stdout }) {
  const text = extractUnifiedDiffFromText(stdout);
  return { patchText: text, extractionMode: 'stdout' };
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
  now = () => new Date(),
  use_worktree
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

  const useWorktree = use_worktree === true || (use_worktree === undefined && !worktreeDisabled(env));
  let worktreePath = null;
  let baseSha = null;
  const commands = [];

  if (useWorktree) {
    const worktreeResult = createStoryWorktree({ rootDir, sandbox_root: policy.sandbox_root, spawn, env });
    if (!worktreeResult.ok) {
      return makeBase({
        ok: false,
        reason: 'opencode_kimi_worktree_create_failed',
        job_id,
        approval_id,
        sandbox_root: policy.sandbox_root,
        candidate_patch_path: candidate_patch_path_relative,
        runtime_installed: true,
        timeout_ms,
        stderr_preview: oneLine(worktreeResult.stderr_preview || worktreeResult.reason || '', 600),
        commands_executed: worktreeResult.command_preview ? [worktreeResult.command_preview] : [],
        next_action: 'inspect_worktree_create_failure'
      });
    }
    worktreePath = worktreeResult.worktree_absolute;
    baseSha = worktreeResult.base_sha;
    if (worktreeResult.command_preview) commands.push(worktreeResult.command_preview);
  }

  const model = resolveModel(env);
  const promptCwd = worktreePath || rootDir;
  const prompt = useWorktree
    ? buildWorktreePrompt({ task, requested_paths, rootDir })
    : buildPrompt({ task, requested_paths, rootDir });
  const args = ['run', '--model', model, '--format', 'json', '--dir', promptCwd, prompt];
  commands.push(commandPreview(command, args));

  let opencodeResult;
  try {
    opencodeResult = spawn(command, args, {
      cwd: promptCwd,
      env: scrubbedEnv,
      encoding: 'utf8',
      timeout: timeout_ms,
      maxBuffer: 1024 * 1024
    });
  } finally {
    // intentional: ensure cleanup attempted on next branch
  }

  const finished = now();
  const timedOut = Boolean(opencodeResult && opencodeResult.error && opencodeResult.error.code === 'ETIMEDOUT');
  const exitCode = opencodeResult && typeof opencodeResult.status === 'number' ? opencodeResult.status : null;
  const stdout = String(opencodeResult && opencodeResult.stdout || '');
  const stderr = String((opencodeResult && opencodeResult.stderr) || (opencodeResult && opencodeResult.error && opencodeResult.error.message) || '');
  const output = `${stdout}\n${stderr}`;

  let patchText = '';
  let extractionMode = 'stdout';
  let worktreeDiffDetail = null;
  if (useWorktree) {
    const extracted = patchFromWorktree({ rootDir, sandbox_root: policy.sandbox_root, base_sha: baseSha, spawn, env });
    patchText = extracted.patchText;
    extractionMode = extracted.extractionMode;
    worktreeDiffDetail = extracted.diff || null;
    if (worktreeDiffDetail && worktreeDiffDetail.ok === false) {
      const fallback = patchFromStdout({ stdout });
      patchText = fallback.patchText;
      extractionMode = fallback.extractionMode;
    }
  } else {
    const extracted = patchFromStdout({ stdout });
    patchText = extracted.patchText;
    extractionMode = extracted.extractionMode;
  }

  const patchLooksValid = validPatchText(patchText);
  const patchValidation = patchLooksValid
    ? validateCandidatePatchAgainstRepository({ rootDir, patchText, requested_paths })
    : { ok: false, reason: 'candidate_patch_invalid' };

  if (patchLooksValid && patchValidation.ok) {
    fs.writeFileSync(candidate_patch_abs, patchText, 'utf8');
  }

  if (useWorktree) {
    const removal = destroyStoryWorktree({ rootDir, sandbox_root: policy.sandbox_root, spawn, env });
    if (!removal.ok) commands.push(`worktree_remove_failed: ${oneLine(removal.stderr_preview || '', 120)}`);
  }

  // Soft-timeout downgrade: when the OpenCode subprocess overran the wall clock
  // but the agent had already produced a fully valid candidate patch (worktree
  // diff captured, validation passed), treat the dispatch as successful. The
  // subprocess timeout in this case is just session-shutdown overhead, not a
  // failure of the agent's work. Without this, the autonomous loop would
  // re-dispatch and burn provider tokens to recompute a result we already have.
  const softTimeoutWithValidPatch = timedOut && patchLooksValid && patchValidation.ok;
  const ok = (softTimeoutWithValidPatch || (!timedOut && exitCode === 0)) && patchLooksValid && patchValidation.ok;
  const reason = ok ? null : classifyFailure({ timedOut, exitCode, patchLooksValid, patchValidation, output, missingKey: false });
  const patchSource = ok ? PATCH_SOURCE : null;

  return makeBase({
    ok,
    reason,
    job_id,
    approval_id,
    sandbox_root: policy.sandbox_root,
    candidate_patch_path: candidate_patch_path_relative,
    command_preview: commands[commands.length - 1] || null,
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
    commands_executed: commands.slice(-10),
    files_modified: ok ? [candidate_patch_path_relative] : [],
    repository_files_modified: [],
    worktree_used: useWorktree,
    patch_extraction_mode: extractionMode,
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
  buildWorktreePrompt,
  classifyFailure,
  nextActionForFailure,
  runtimeInstalled,
  dispatchOpenCodeKimi
};
