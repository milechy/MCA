const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { isAllowedSandboxRoot } = require('./opencode-sandbox-plan');
const { DEFAULT_ALLOWED_PATHS, DEFAULT_FORBIDDEN_PATHS } = require('./opencode-dry-run');

const OPENCODE_SANDBOX_ENV = 'RALPH_OPENCODE_SANDBOX_ENABLED';
const DEFAULT_SANDBOX_ALLOWED_PATHS = Object.freeze(['README.md', ...DEFAULT_ALLOWED_PATHS]);
const RALPH_RUNTIME_STATE_PATTERNS = Object.freeze([
  '.ralph/stories/',
  '.ralph/tmp/',
  '.ralph/approval-pending/',
  '.ralph/logs/',
  '.ralph/approval-log.jsonl'
]);

function oneLine(value, maxLength = 180) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function opencodeSandboxEnabled(env = process.env) {
  return env[OPENCODE_SANDBOX_ENV] === 'true';
}

function runGit(args, rootDir) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function runGitRaw(args, rootDir) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function parseGitStatusPorcelain(statusText = '') {
  return String(statusText || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/g, ''))
    .filter((line) => line.length > 0)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.length > 3 ? line.slice(3).trim() : '';
      const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
      return { status, path: filePath.replace(/\\/g, '/') };
    })
    .filter((entry) => entry.path);
}

function isRalphRuntimeStatePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return RALPH_RUNTIME_STATE_PATTERNS.some((pattern) => {
    if (pattern.endsWith('/')) return normalized === pattern.slice(0, -1) || normalized.startsWith(pattern);
    return normalized === pattern;
  });
}

function dirtyEntries(rootDir) {
  try {
    return parseGitStatusPorcelain(runGitRaw(['status', '--porcelain', '-uall'], rootDir));
  } catch {
    return null;
  }
}

function blockingDirtyEntries(rootDir) {
  const entries = dirtyEntries(rootDir);
  if (entries === null) return null;
  return entries.filter((entry) => !isRalphRuntimeStatePath(entry.path));
}

function workingTreeClean(rootDir) {
  const blocking = blockingDirtyEntries(rootDir);
  return Array.isArray(blocking) && blocking.length === 0;
}

function currentBranch(rootDir) {
  try {
    return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], rootDir);
  } catch {
    return null;
  }
}

function branchAllowed(branch) {
  return Boolean(branch) && branch !== 'main' && branch !== 'master';
}

function loadApproval(rootDir, approvalId) {
  if (!approvalId) return null;
  const pendingPath = `${rootDir}/.ralph/approval-pending/${approvalId}.json`;
  if (!fs.existsSync(pendingPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch {
    return null;
  }
}

function approvalStatus(approval, now = new Date()) {
  if (!approval) return { ok: false, reason: 'approval_missing' };
  if (approval.status !== 'approved') return { ok: false, reason: 'approval_not_approved' };
  if (approval.expires_at && Date.parse(approval.expires_at) <= now.getTime()) {
    return { ok: false, reason: 'approval_expired' };
  }
  return { ok: true, reason: null };
}

function normalizeRequestedPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.map((p) => oneLine(p, 160)).filter(Boolean).slice(0, 20);
}

function pathMatchesPattern(requestedPath, pattern) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return requestedPath === prefix || requestedPath.startsWith(`${prefix}/`);
  }
  if (pattern.startsWith('*.')) {
    return requestedPath.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return requestedPath === prefix || requestedPath.startsWith(`${prefix}.`);
  }
  return requestedPath === pattern || requestedPath.startsWith(`${pattern}/`);
}

function isForbiddenRequestedPath(requestedPath, forbiddenPatterns = DEFAULT_FORBIDDEN_PATHS) {
  const normalized = String(requestedPath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return true;
  return forbiddenPatterns.some((pattern) => pathMatchesPattern(normalized, pattern));
}

function isAllowedRequestedPath(requestedPath, allowedPatterns = DEFAULT_SANDBOX_ALLOWED_PATHS) {
  const normalized = String(requestedPath || '').replace(/\\/g, '/');
  return allowedPatterns.some((pattern) => pathMatchesPattern(normalized, pattern));
}

function classifyRequestedPaths(paths, allowedPatterns = DEFAULT_SANDBOX_ALLOWED_PATHS, forbiddenPatterns = DEFAULT_FORBIDDEN_PATHS) {
  const requested = normalizeRequestedPaths(paths);
  const blocked = requested.filter((p) => isForbiddenRequestedPath(p, forbiddenPatterns) || !isAllowedRequestedPath(p, allowedPatterns));
  return { requested, blocked };
}

function makeBaseResult(overrides = {}) {
  return {
    ok: false,
    stage: 'opencode_sandbox_runner_preflight',
    reason: null,
    start_allowed: false,
    approval_id: null,
    sandbox_root: null,
    branch: null,
    working_tree_clean: false,
    dirty_entries: [],
    ignored_runtime_state_entries: [],
    opencode_sandbox_enabled: false,
    requested_paths: [],
    blocked_paths: [],
    pre_secret_scan_ok: false,
    execution_connected: false,
    opencode_execution_started: false,
    commands_executed: [],
    files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_preflight_failure',
    ...overrides
  };
}

function opencodeSandboxRunnerPreflight({ rootDir = process.cwd(), approval_id, sandbox_root, requested_paths = [], pre_secret_scan_ok = false, env = process.env, now = new Date() } = {}) {
  const branch = currentBranch(rootDir);
  const entries = dirtyEntries(rootDir);
  const gitStatusFailed = entries === null;
  const blockingEntries = gitStatusFailed ? [] : entries.filter((entry) => !isRalphRuntimeStatePath(entry.path));
  const ignoredEntries = gitStatusFailed ? [] : entries.filter((entry) => isRalphRuntimeStatePath(entry.path));
  const clean = !gitStatusFailed && blockingEntries.length === 0;
  const enabled = opencodeSandboxEnabled(env);
  const { requested, blocked } = classifyRequestedPaths(requested_paths);
  const base = {
    approval_id: approval_id || null,
    sandbox_root: sandbox_root || null,
    branch,
    working_tree_clean: clean,
    dirty_entries: blockingEntries.map((entry) => entry.path).slice(0, 20),
    ignored_runtime_state_entries: ignoredEntries.map((entry) => entry.path).slice(0, 20),
    opencode_sandbox_enabled: enabled,
    requested_paths: requested,
    blocked_paths: blocked,
    pre_secret_scan_ok: pre_secret_scan_ok === true
  };

  if (gitStatusFailed) return makeBaseResult({ ...base, reason: 'git_status_failed' });
  if (!approval_id) return makeBaseResult({ ...base, reason: 'approval_id_required' });
  const approval = loadApproval(rootDir, approval_id);
  const approvalCheck = approvalStatus(approval, now);
  if (!approvalCheck.ok) return makeBaseResult({ ...base, reason: approvalCheck.reason });
  if (!sandbox_root) return makeBaseResult({ ...base, reason: 'sandbox_root_invalid' });
  if (!isAllowedSandboxRoot(sandbox_root)) return makeBaseResult({ ...base, reason: 'sandbox_root_not_allowed' });
  if (!clean) return makeBaseResult({ ...base, reason: 'working_tree_dirty' });
  if (!branchAllowed(branch)) return makeBaseResult({ ...base, reason: 'branch_not_allowed' });
  if (blocked.length > 0) return makeBaseResult({ ...base, reason: 'requested_path_forbidden' });
  if (pre_secret_scan_ok !== true) return makeBaseResult({ ...base, reason: 'pre_secret_scan_failed' });
  if (!enabled) return makeBaseResult({ ...base, reason: 'opencode_sandbox_env_not_enabled' });

  return makeBaseResult({
    ...base,
    ok: true,
    reason: null,
    start_allowed: true,
    next_action: 'phase12_6_sandbox_execution_can_be_considered'
  });
}

module.exports = {
  OPENCODE_SANDBOX_ENV,
  DEFAULT_SANDBOX_ALLOWED_PATHS,
  RALPH_RUNTIME_STATE_PATTERNS,
  opencodeSandboxEnabled,
  parseGitStatusPorcelain,
  isRalphRuntimeStatePath,
  dirtyEntries,
  blockingDirtyEntries,
  workingTreeClean,
  currentBranch,
  branchAllowed,
  approvalStatus,
  normalizeRequestedPaths,
  isForbiddenRequestedPath,
  isAllowedRequestedPath,
  classifyRequestedPaths,
  opencodeSandboxRunnerPreflight
};
