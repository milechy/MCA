const { spawnSync } = require('node:child_process');
const { readApproval } = require('../ralph/approval-manager');
const { APPROVAL_STATUSES } = require('../ralph/types');
const { currentHead, currentBranch, gitStatusShort } = require('./opencode-push-approval');

const DEFAULT_TIMEOUT_MS = 30000;
const SECRET_LIKE_PATTERN = /(?:\b\d{8,}:[A-Za-z0-9_-]{20,}\b|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})/g;

function oneLine(value, maxLength = 240) {
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

function blocked(reason, extra = {}) {
  const now = new Date().toISOString();
  return {
    ok: false,
    stage: 'opencode_push',
    reason,
    approval_id: extra.approval_id || null,
    commit_sha: extra.commit_sha || null,
    branch: extra.branch || null,
    remote: extra.remote || null,
    command: 'git push',
    exit_code: null,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    execution_connected: false,
    push_allowed: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_opencode_push_preflight_failure'
  };
}

function opencodePushPreflight({ rootDir = process.cwd(), approval_id } = {}) {
  if (!approval_id) return blocked('approval_id_required');
  let approval;
  try {
    approval = readApproval(rootDir, approval_id);
  } catch {
    return blocked('approval_not_found', { approval_id });
  }
  const base = { approval_id, commit_sha: approval.commit_sha, branch: approval.branch, remote: approval.remote };
  if (approval.status !== APPROVAL_STATUSES.APPROVED) return blocked('approval_not_approved', base);
  if (approval.requested_action !== 'opencode_commit_push') return blocked('requested_action_not_push', base);
  if (approval.remote !== 'origin') return blocked('remote_not_allowed', base);
  if (!approval.branch) return blocked('branch_required', base);
  if (!approval.commit_sha) return blocked('commit_sha_required', base);
  const head = currentHead(rootDir);
  if (head !== approval.commit_sha) return blocked('commit_sha_not_head', base);
  const branch = currentBranch(rootDir);
  if (branch !== approval.branch) return blocked('branch_not_current', base);
  const status = gitStatusShort(rootDir);
  if (status === null) return blocked('git_status_failed', base);
  if (status !== '') return blocked('working_tree_dirty', base);
  return {
    ok: true,
    stage: 'opencode_push_preflight',
    reason: null,
    approval_id,
    commit_sha: approval.commit_sha,
    branch: approval.branch,
    remote: approval.remote,
    command: 'git push',
    execution_connected: false,
    push_allowed: true,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'push_commit_to_origin_branch'
  };
}

function pushOpenCodeCommit({ rootDir = process.cwd(), approval_id, timeout_ms = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  const preflight = opencodePushPreflight({ rootDir, approval_id });
  if (!preflight.ok) return { ...preflight, stage: 'opencode_push' };
  const startedAt = now().toISOString();
  const result = spawnSync('git', ['push', preflight.remote, `HEAD:${preflight.branch}`], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 128
  });
  const finishedAt = now().toISOString();
  const ok = result.status === 0;
  return {
    ok,
    stage: 'opencode_push',
    reason: ok ? null : 'opencode_push_failed',
    preflight,
    approval_id: preflight.approval_id,
    commit_sha: preflight.commit_sha,
    branch: preflight.branch,
    remote: preflight.remote,
    command: 'git push',
    exit_code: typeof result.status === 'number' ? result.status : null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    stdout_preview: oneLine(result.stdout),
    stderr_preview: oneLine(result.stderr || result.error?.message || ''),
    execution_connected: true,
    push_allowed: true,
    commands_executed: ['git push origin HEAD:<approved_branch>'],
    files_modified: [],
    repository_files_modified: [],
    git_status_files: gitStatusShort(rootDir) === '' ? [] : String(gitStatusShort(rootDir) || '').split('\n').filter(Boolean),
    commit_created: false,
    push_performed: ok,
    deploy_performed: false,
    migration_performed: false,
    next_action: ok ? 'open_pull_request_or_continue_operator_review' : 'fix_push_failure'
  };
}

module.exports = { opencodePushPreflight, pushOpenCodeCommit };
