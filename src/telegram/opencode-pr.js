const { readApproval } = require('../ralph/approval-manager');
const { APPROVAL_STATUSES } = require('../ralph/types');
const { currentHead, currentBranch, gitStatusShort } = require('./opencode-push-approval');

function nowIso(now = () => new Date()) {
  return now().toISOString();
}

function oneLine(value, maxLength = 240) {
  const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function blocked(reason, extra = {}) {
  const timestamp = nowIso(extra.now || (() => new Date()));
  return {
    ok: false,
    stage: 'opencode_pr',
    reason,
    approval_id: extra.approval_id || null,
    commit_sha: extra.commit_sha || null,
    head_branch: extra.head_branch || null,
    base_branch: extra.base_branch || null,
    title: extra.title || null,
    pr_url: null,
    pr_number: null,
    started_at: timestamp,
    finished_at: timestamp,
    duration_ms: 0,
    execution_connected: false,
    pr_allowed: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_pr_preflight_failure'
  };
}

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function opencodePrPreflight({ rootDir = process.cwd(), approval_id, now } = {}) {
  if (!approval_id) return blocked('approval_id_required', { now });
  let approval;
  try {
    approval = readApproval(rootDir, approval_id);
  } catch {
    return blocked('approval_not_found', { approval_id, now });
  }
  const base = { approval_id, commit_sha: approval.commit_sha, head_branch: approval.head_branch, base_branch: approval.base_branch, title: approval.title, now };
  if (approval.status !== APPROVAL_STATUSES.APPROVED) return blocked('approval_not_approved', base);
  if (approval.requested_action !== 'opencode_create_pr') return blocked('requested_action_not_pr', base);
  if (!approval.commit_sha) return blocked('commit_sha_required', base);
  if (!approval.head_branch) return blocked('head_branch_required', base);
  if (!approval.base_branch) return blocked('base_branch_required', base);
  if (approval.head_branch === approval.base_branch) return blocked('base_branch_matches_head', base);
  if (currentHead(rootDir) !== approval.commit_sha) return blocked('commit_sha_not_head', base);
  if (currentBranch(rootDir) !== approval.head_branch) return blocked('head_branch_not_current', base);
  const status = gitStatusShort(rootDir);
  if (status === null) return blocked('git_status_failed', base);
  if (status !== '') return blocked('working_tree_dirty', base);
  return {
    ok: true,
    stage: 'opencode_pr_preflight',
    reason: null,
    approval_id,
    commit_sha: approval.commit_sha,
    head_branch: approval.head_branch,
    base_branch: approval.base_branch,
    title: approval.title,
    body: approval.body || '',
    execution_connected: false,
    pr_allowed: true,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'create_github_pull_request'
  };
}

function createPullRequestWithClient(client, input) {
  if (!client || typeof client.createPullRequest !== 'function') {
    return { ok: false, reason: 'github_client_required' };
  }
  return client.createPullRequest(input);
}

function createOpenCodePullRequest({ rootDir = process.cwd(), approval_id, githubClient, repository_full_name, now = () => new Date() } = {}) {
  const preflight = opencodePrPreflight({ rootDir, approval_id, now });
  if (!preflight.ok) return { ...preflight, stage: 'opencode_pr' };
  const startedAt = nowIso(now);
  const created = createPullRequestWithClient(githubClient, {
    repository_full_name,
    title: preflight.title,
    body: preflight.body,
    head: preflight.head_branch,
    base: preflight.base_branch
  });
  const finishedAt = nowIso(now);
  const ok = created && created.ok === true;
  return {
    ok,
    stage: 'opencode_pr',
    reason: ok ? null : created?.reason || 'github_pr_creation_failed',
    approval_id: preflight.approval_id,
    commit_sha: preflight.commit_sha,
    head_branch: preflight.head_branch,
    base_branch: preflight.base_branch,
    title: preflight.title,
    pr_url: ok ? oneLine(created.url || created.html_url || '') : null,
    pr_number: ok && Number.isInteger(created.number) ? created.number : null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    execution_connected: true,
    pr_allowed: true,
    commands_executed: ['github.createPullRequest'],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: ok,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: ok ? 'review_pull_request' : 'fix_pr_creation_failure'
  };
}

module.exports = { opencodePrPreflight, createOpenCodePullRequest, createPullRequestWithClient };
