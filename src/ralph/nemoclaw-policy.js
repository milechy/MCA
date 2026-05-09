const path = require('node:path');

const NEMOCLAW_ACTIONS = Object.freeze({
  RUN_CANDIDATE_PATCH: 'run_candidate_patch'
});

const DEFAULT_CANDIDATE_PATCH = 'candidate.patch';
const MAX_PREVIEW_CHARS = 600;
const MAX_TASK_CHARS = 1200;
const MAX_PATHS = 25;

const FORBIDDEN_RUNTIME_ARGS = Object.freeze([
  '--apply',
  '--commit',
  '--push',
  '--pr',
  '--pull-request',
  '--merge',
  '--deploy',
  '--migrate',
  '--migration',
  '--shell',
  '--command',
  '--exec',
  '--raw-logs',
  '--print-secrets',
  '--persist-secrets',
  '--dangerously-skip-permissions'
]);

const SECRET_PATTERNS = [
  /\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s`'\"]+/gi
];

function oneLine(value, maxLength = MAX_PREVIEW_CHARS) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactText(value, maxLength = MAX_PREVIEW_CHARS) {
  let text = oneLine(value, maxLength);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, (match, key) => key ? `${key}=[REDACTED]` : '[REDACTED]');
  return text;
}

function normalizeTask(value) {
  return redactText(value, MAX_TASK_CHARS);
}

function normalizePath(value) {
  const item = String(value || '').replace(/\\/g, '/').trim();
  if (!item || path.isAbsolute(item) || item.split('/').includes('..')) return null;
  return redactText(item, 240);
}

function normalizeRequestedPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return Array.from(new Set(paths.map(normalizePath).filter(Boolean))).slice(0, MAX_PATHS);
}

function sandboxCandidatePatchPath(sandboxRoot) {
  const root = normalizePath(sandboxRoot);
  if (!root || !root.startsWith('.ralph/tmp/')) return null;
  return `${root.replace(/\/+$/g, '')}/${DEFAULT_CANDIDATE_PATCH}`;
}

function argsContainForbiddenEscalation(args = []) {
  if (!Array.isArray(args)) return true;
  const joined = args.map(String).join(' ');
  if (/[;&|`$<>]/.test(joined)) return true;
  return args.some((arg) => FORBIDDEN_RUNTIME_ARGS.includes(String(arg)));
}

function outputIsCandidatePatchOnly(outputPath, sandboxRoot) {
  return normalizePath(outputPath) === sandboxCandidatePatchPath(sandboxRoot);
}

function blocked(reason, extra = {}) {
  return {
    ok: false,
    stage: 'nemoclaw_policy',
    reason,
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    action: extra.action || null,
    sandbox_root: extra.sandbox_root || null,
    candidate_patch_path: null,
    requested_paths: extra.requested_paths || [],
    task_preview: extra.task_preview || '',
    allowed_outputs: [],
    execution_allowed: false,
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
    next_action: 'fix_nemoclaw_policy_request'
  };
}

function buildNemoClawPolicy({ action, sandbox_root, requested_paths = [], task, args = null } = {}) {
  const safePaths = normalizeRequestedPaths(requested_paths);
  const taskPreview = normalizeTask(task);
  const candidatePath = sandboxCandidatePatchPath(sandbox_root);
  const base = { action, sandbox_root, requested_paths: safePaths, task_preview: taskPreview };

  if (action !== NEMOCLAW_ACTIONS.RUN_CANDIDATE_PATCH) return blocked('nemoclaw_action_not_allowed', base);
  if (!taskPreview) return blocked('task_required', base);
  if (safePaths.length === 0) return blocked('requested_paths_required', base);
  if (!candidatePath) return blocked('sandbox_root_not_allowed', base);
  if (args !== null && argsContainForbiddenEscalation(args)) return blocked('nemoclaw_runtime_args_not_allowed', base);

  return {
    ok: true,
    stage: 'nemoclaw_policy',
    reason: null,
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    action,
    sandbox_root: normalizePath(sandbox_root),
    candidate_patch_path: candidatePath,
    requested_paths: safePaths,
    task_preview: taskPreview,
    allowed_outputs: [candidatePath],
    execution_allowed: true,
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
    next_action: 'run_opencode_through_nemoclaw_gateway'
  };
}

function sanitizeGatewayResult(result = {}, policy = {}) {
  const candidatePath = policy.candidate_patch_path || result.candidate_patch_path || null;
  const candidateOnly = candidatePath && outputIsCandidatePatchOnly(candidatePath, policy.sandbox_root || result.sandbox_root);
  return {
    ...result,
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    stdout_preview: redactText(result.stdout_preview || '', MAX_PREVIEW_CHARS),
    stderr_preview: redactText(result.stderr_preview || '', MAX_PREVIEW_CHARS),
    candidate_patch_path: candidateOnly ? candidatePath : null,
    files_modified: candidateOnly ? [candidatePath] : [],
    repository_files_modified: [],
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
    commands_executed: Array.isArray(result.commands_executed) ? result.commands_executed.map((item) => redactText(item, 180)).slice(0, 5) : []
  };
}

module.exports = {
  NEMOCLAW_ACTIONS,
  DEFAULT_CANDIDATE_PATCH,
  FORBIDDEN_RUNTIME_ARGS,
  oneLine,
  redactText,
  normalizeTask,
  normalizePath,
  normalizeRequestedPaths,
  sandboxCandidatePatchPath,
  argsContainForbiddenEscalation,
  outputIsCandidatePatchOnly,
  buildNemoClawPolicy,
  sanitizeGatewayResult
};
