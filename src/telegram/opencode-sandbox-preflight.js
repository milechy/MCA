const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { isAllowedSandboxRoot } = require('./opencode-sandbox-plan');
const { DEFAULT_ALLOWED_PATHS, DEFAULT_FORBIDDEN_PATHS } = require('./opencode-dry-run');

const OPENCODE_SANDBOX_ENV = 'RALPH_OPENCODE_SANDBOX_ENABLED';

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

function workingTreeClean(rootDir) {
  try {
    return runGit(['status', '--porcelain'], rootDir) === '';
  } catch {
    return false;
  }
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

function isAllowedRequestedPath(requestedPath, allowedPatterns = DEFAULT_ALLOWED_PATHS) {
  const normalized = String(requestedPath || '').replace(/\\/g, '/');
  return allowedPatterns.some((pattern) => pathMatchesPattern(normalized, pattern));
}

function classifyRequestedPaths(paths, allowedPatterns = DEFAULT_ALLOWED_PATHS, forbiddenPatterns = DEFAULT_FORBIDDEN_PATHS) {
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
  const clean = workingTreeClean(rootDir);
  const enabled = opencodeSandboxEnabled(env);
  const { requested, blocked } = classifyRequestedPaths(requested_paths);
  const base = {
    approval_id: approval_id || null,
    sandbox_root: sandbox_root || null,
    branch,
    working_tree_clean: clean,
    opencode_sandbox_enabled: enabled,
    requested_paths: requested,
    blocked_paths: blocked,
    pre_secret_scan_ok: pre_secret_scan_ok === true
  };

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
  opencodeSandboxEnabled,
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
