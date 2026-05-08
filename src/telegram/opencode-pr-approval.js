const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { APPROVAL_TYPES, APPROVAL_STATUSES } = require('../ralph/types');
const { createApproval } = require('../ralph/approval-manager');
const { currentHead, currentBranch, gitStatusShort } = require('./opencode-push-approval');

function defaultPrApprovalId(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `APR-OPENCODE-PR-${stamp}`;
}

function writeApproval(rootDir, approval) {
  const filePath = path.join(rootDir, '.ralph', 'approval-pending', `${approval.approval_id}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  return approval;
}

function normalizeBranch(value) {
  return String(value || '').trim();
}

function branchExists(rootDir, branch) {
  const result = spawnSync('git', ['rev-parse', '--verify', branch], { cwd: rootDir, encoding: 'utf8', maxBuffer: 1024 * 8 });
  return result.status === 0;
}

function blocked(reason, extra = {}) {
  return {
    ok: false,
    stage: 'opencode_pr_approval',
    reason,
    approval: null,
    approval_id: null,
    commit_sha: extra.commit_sha || null,
    head_branch: extra.head_branch || null,
    base_branch: extra.base_branch || null,
    pr_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_pr_approval_preflight_failure'
  };
}

function createOpenCodePrApproval({ rootDir = process.cwd(), commit_sha, head_branch, base_branch = 'main', title, body, allowed_user_ids = [], expires_at, now = new Date() } = {}) {
  const requestedSha = String(commit_sha || '').trim();
  const requestedHead = normalizeBranch(head_branch) || currentBranch(rootDir);
  const requestedBase = normalizeBranch(base_branch) || 'main';
  const head = currentHead(rootDir);
  const current = currentBranch(rootDir);

  if (!requestedSha) return blocked('commit_sha_required', { head_branch: requestedHead, base_branch: requestedBase });
  if (requestedSha !== head) return blocked('commit_sha_not_head', { commit_sha: requestedSha, head_branch: requestedHead, base_branch: requestedBase });
  if (!requestedHead) return blocked('head_branch_required', { commit_sha: requestedSha, base_branch: requestedBase });
  if (requestedHead !== current) return blocked('head_branch_not_current', { commit_sha: requestedSha, head_branch: requestedHead, base_branch: requestedBase });
  if (!requestedBase) return blocked('base_branch_required', { commit_sha: requestedSha, head_branch: requestedHead });
  if (requestedBase === requestedHead) return blocked('base_branch_matches_head', { commit_sha: requestedSha, head_branch: requestedHead, base_branch: requestedBase });
  if (!branchExists(rootDir, requestedBase)) return blocked('base_branch_not_found', { commit_sha: requestedSha, head_branch: requestedHead, base_branch: requestedBase });
  const status = gitStatusShort(rootDir);
  if (status === null) return blocked('git_status_failed', { commit_sha: requestedSha, head_branch: requestedHead, base_branch: requestedBase });
  if (status !== '') return blocked('working_tree_dirty', { commit_sha: requestedSha, head_branch: requestedHead, base_branch: requestedBase });

  const prTitle = String(title || `OpenCode change ${requestedSha.slice(0, 12)}`).trim().slice(0, 120);
  const prBody = String(body || 'Created by controlled Telegram OpenCode flow.').trim().slice(0, 4000);
  const plan = {
    story_id: `STORY-${requestedSha.slice(0, 12)}`,
    objective: 'Approve opening a GitHub pull request for a reviewed OpenCode branch',
    summary: 'OpenCode controlled PR approval',
    requested_action: 'opencode_create_pr',
    commit_sha: requestedSha,
    head_branch: requestedHead,
    base_branch: requestedBase,
    title: prTitle,
    body: prBody,
    pr_allowed: false,
    execution_connected: false,
    production_deploy_allowed: false,
    migration_allowed: false
  };
  const approval = createApproval(plan, { score: 0, category: 'low', label: 'RISK_0_LOW', requires_approval: true }, {
    rootDir,
    approval_id: defaultPrApprovalId(now),
    approval_type: APPROVAL_TYPES.PLAN,
    requested_action: 'opencode_create_pr',
    allowed_user_ids,
    expires_at
  });
  approval.status = APPROVAL_STATUSES.PENDING;
  approval.commit_sha = requestedSha;
  approval.head_branch = requestedHead;
  approval.base_branch = requestedBase;
  approval.title = prTitle;
  approval.body = prBody;
  approval.pr_allowed = false;
  approval.execution_connected = false;
  approval.commands_executed = [];
  approval.files_modified = [];
  approval.repository_files_modified = [];
  approval.commit_created = false;
  approval.push_performed = false;
  approval.pr_created = false;
  approval.deploy_performed = false;
  approval.migration_performed = false;
  writeApproval(rootDir, approval);

  return {
    ok: true,
    stage: 'opencode_pr_approval',
    reason: null,
    approval,
    approval_id: approval.approval_id,
    commit_sha: requestedSha,
    head_branch: requestedHead,
    base_branch: requestedBase,
    title: prTitle,
    pr_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'approve_or_deny_pr_before_github_pr_creation'
  };
}

module.exports = { createOpenCodePrApproval, defaultPrApprovalId, branchExists };
