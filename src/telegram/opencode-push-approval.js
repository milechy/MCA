const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { APPROVAL_TYPES, APPROVAL_STATUSES } = require('../ralph/types');
const { createApproval } = require('../ralph/approval-manager');
const { parseGitStatusPorcelain, isRalphRuntimeStatePath } = require('./opencode-sandbox-preflight');

function defaultPushApprovalId(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `APR-OPENCODE-PUSH-${stamp}`;
}

function normalizeRef(value) {
  return String(value || '').trim();
}

function currentHead(rootDir) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8', maxBuffer: 1024 * 8 });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function currentBranch(rootDir) {
  const result = spawnSync('git', ['branch', '--show-current'], { cwd: rootDir, encoding: 'utf8', maxBuffer: 1024 * 8 });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function gitStatusShort(rootDir) {
  const result = spawnSync('git', ['status', '--short'], { cwd: rootDir, encoding: 'utf8', maxBuffer: 1024 * 64 });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

// Phase 1 #10: like sandbox-preflight, the push-stage dirty check must
// ignore Ralph's own runtime state (.ralph/stories, .ralph/tmp, etc.) and,
// when the caller is dispatched via a worktree-isolated runner (where main
// repo's working tree state is incidental), downgrade dirty to informational.
//
// Bug G (30-min soak after Phase 1 #9 (I)): the previous gitStatusShort
// equality-to-'' check escalated freshly-COMMITed stories at the push
// approval stage just because another concurrent story's APPLY had
// transiently dirtied the main tree. With Phase 1 #8 critical-section
// serialization, APPLY/COMMIT are serialized; but PUSH_APPROVAL_PENDING is
// outside the critical section, so by the time we reach push approval, the
// next story is legitimately mid-APPLY. The dirty signal is meaningless to
// our push.
function dirtyEntriesFromStatusShort(rootDir) {
  const raw = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: rootDir, encoding: 'utf8', maxBuffer: 1024 * 64 });
  if (raw.status !== 0) return null;
  return parseGitStatusPorcelain(raw.stdout || '');
}

function blockingDirtyEntries(rootDir) {
  const entries = dirtyEntriesFromStatusShort(rootDir);
  if (entries === null) return null;
  return entries.filter((entry) => !isRalphRuntimeStatePath(entry.path));
}

function blocked(reason, extra = {}) {
  return {
    ok: false,
    stage: 'opencode_push_approval',
    reason,
    approval: null,
    approval_id: null,
    commit_sha: extra.commit_sha || null,
    branch: extra.branch || null,
    remote: extra.remote || null,
    push_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_push_approval_preflight_failure'
  };
}

function createOpenCodePushApproval({ rootDir = process.cwd(), commit_sha, branch, remote = 'origin', allowed_user_ids = [], expires_at, now = new Date(), worktree_isolated = false } = {}) {
  const head = currentHead(rootDir);
  const current = currentBranch(rootDir);
  const requestedSha = normalizeRef(commit_sha);
  const requestedBranch = normalizeRef(branch) || current;
  const requestedRemote = normalizeRef(remote) || 'origin';

  if (!requestedSha) return blocked('commit_sha_required', { branch: requestedBranch, remote: requestedRemote });
  if (requestedSha !== head) return blocked('commit_sha_not_head', { commit_sha: requestedSha, branch: requestedBranch, remote: requestedRemote });
  if (!requestedBranch) return blocked('branch_required', { commit_sha: requestedSha, remote: requestedRemote });
  if (requestedBranch !== current) return blocked('branch_not_current', { commit_sha: requestedSha, branch: requestedBranch, remote: requestedRemote });
  if (requestedRemote !== 'origin') return blocked('remote_not_allowed', { commit_sha: requestedSha, branch: requestedBranch, remote: requestedRemote });
  const blocking = blockingDirtyEntries(rootDir);
  if (blocking === null) return blocked('git_status_failed', { commit_sha: requestedSha, branch: requestedBranch, remote: requestedRemote });
  if (blocking.length > 0 && !worktree_isolated) {
    return blocked('working_tree_dirty', { commit_sha: requestedSha, branch: requestedBranch, remote: requestedRemote });
  }

  const plan = {
    story_id: `STORY-${requestedSha.slice(0, 12)}`,
    objective: 'Approve pushing a reviewed local OpenCode commit to origin branch',
    summary: 'OpenCode controlled push approval',
    requested_action: 'opencode_commit_push',
    commit_sha: requestedSha,
    branch: requestedBranch,
    remote: requestedRemote,
    push_allowed: false,
    execution_connected: false,
    production_deploy_allowed: false,
    migration_allowed: false
  };
  const approval = createApproval(plan, { score: 0, category: 'low', label: 'RISK_0_LOW', requires_approval: true }, {
    rootDir,
    approval_id: defaultPushApprovalId(now),
    approval_type: APPROVAL_TYPES.PLAN,
    requested_action: 'opencode_commit_push',
    allowed_user_ids,
    expires_at
  });
  approval.status = APPROVAL_STATUSES.PENDING;
  approval.commit_sha = requestedSha;
  approval.branch = requestedBranch;
  approval.remote = requestedRemote;
  approval.push_allowed = false;
  approval.execution_connected = false;
  approval.commands_executed = [];
  approval.files_modified = [];
  approval.repository_files_modified = [];
  approval.commit_created = false;
  approval.push_performed = false;
  approval.deploy_performed = false;
  approval.migration_performed = false;

  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${approval.approval_id}.json`), `${JSON.stringify(approval, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    stage: 'opencode_push_approval',
    reason: null,
    approval,
    approval_id: approval.approval_id,
    commit_sha: requestedSha,
    branch: requestedBranch,
    remote: requestedRemote,
    push_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'approve_or_deny_push_before_git_push'
  };
}

module.exports = { createOpenCodePushApproval, defaultPushApprovalId, currentHead, currentBranch, gitStatusShort };
