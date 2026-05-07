const fs = require('node:fs');
const path = require('node:path');
const { calculateDiffHash } = require('../ralph/hash');
const { APPROVAL_TYPES, APPROVAL_STATUSES } = require('../ralph/types');
const { createApproval } = require('../ralph/approval-manager');
const { readApproval } = require('../ralph/approval-manager');
const { calculatePatchHash } = require('./opencode-patch-approval');
const { changedFilesFromTouched, gitChangedFiles } = require('./opencode-apply');

function defaultCommitApprovalId(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `APR-OPENCODE-COMMIT-${stamp}`;
}

function blocked(reason, extra = {}) {
  return {
    ok: false,
    stage: 'opencode_commit_approval',
    reason,
    approval: null,
    approval_id: null,
    source_approval_id: extra.approval_id || null,
    patch_hash: extra.patch_hash || null,
    commit_message: null,
    commit_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_commit_approval_preflight_failure'
  };
}

function normalizeCommitMessage(message) {
  const normalized = String(message || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, 160);
}

function createOpenCodeCommitApproval({ rootDir = process.cwd(), approval_id, patch_hash, commit_message, allowed_user_ids = [], expires_at, now = new Date() } = {}) {
  if (!approval_id) return blocked('source_approval_id_required');
  const message = normalizeCommitMessage(commit_message);
  if (!message) return blocked('commit_message_required', { approval_id, patch_hash });

  let sourceApproval;
  try {
    sourceApproval = readApproval(rootDir, approval_id);
  } catch {
    return blocked('source_approval_not_found', { approval_id, patch_hash });
  }

  const base = { approval_id, patch_hash, candidate_patch_path: sourceApproval.candidate_patch_path };
  if (sourceApproval.status !== APPROVAL_STATUSES.APPROVED) return blocked('source_approval_not_approved', base);
  if (sourceApproval.requested_action !== 'opencode_candidate_patch_apply') return blocked('source_requested_action_not_apply', base);
  if (!sourceApproval.patch_hash || patch_hash !== sourceApproval.patch_hash) return blocked('patch_hash_mismatch', base);
  if (calculatePatchHash(rootDir, sourceApproval) !== sourceApproval.patch_hash) return blocked('candidate_patch_hash_mismatch', base);

  const repositoryFilesModified = changedFilesFromTouched(sourceApproval.files_touched || [], rootDir);
  if (repositoryFilesModified.length === 0) return blocked('applied_files_missing', base);

  const plan = {
    story_id: `STORY-${approval_id}`,
    objective: 'Approve committing an already-applied OpenCode candidate patch after gates pass',
    summary: 'OpenCode controlled commit approval',
    requested_action: 'opencode_candidate_patch_commit',
    source_approval_id: approval_id,
    candidate_patch_path: sourceApproval.candidate_patch_path,
    sandbox_root: sourceApproval.sandbox_root,
    patch_hash: sourceApproval.patch_hash,
    files_touched: sourceApproval.files_touched || [],
    repository_files_modified: repositoryFilesModified,
    git_status_files: gitChangedFiles(rootDir),
    commit_message: message,
    risk: sourceApproval.risk,
    commit_allowed: false,
    execution_connected: false
  };

  const commitApprovalId = defaultCommitApprovalId(now);
  const approval = createApproval(plan, sourceApproval.risk, {
    rootDir,
    approval_id: commitApprovalId,
    approval_type: APPROVAL_TYPES.DIFF,
    requested_action: 'opencode_candidate_patch_commit',
    allowed_user_ids,
    expires_at,
    pre_exec_diff_hash: calculateDiffHash(rootDir)
  });

  approval.status = APPROVAL_STATUSES.PENDING;
  approval.source_approval_id = approval_id;
  approval.patch_hash = sourceApproval.patch_hash;
  approval.candidate_patch_path = sourceApproval.candidate_patch_path;
  approval.sandbox_root = sourceApproval.sandbox_root;
  approval.files_touched = sourceApproval.files_touched || [];
  approval.repository_files_modified = repositoryFilesModified;
  approval.git_status_files = gitChangedFiles(rootDir);
  approval.commit_message = message;
  approval.commit_allowed = false;
  approval.execution_connected = false;
  approval.commands_executed = [];
  approval.files_modified = repositoryFilesModified;
  approval.commit_created = false;
  approval.push_performed = false;
  approval.deploy_performed = false;
  approval.migration_performed = false;

  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${approval.approval_id}.json`), `${JSON.stringify(approval, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    stage: 'opencode_commit_approval',
    reason: null,
    approval,
    approval_id: approval.approval_id,
    source_approval_id: approval.source_approval_id,
    patch_hash: approval.patch_hash,
    commit_message: approval.commit_message,
    pre_commit_diff_hash: approval.pre_exec_diff_hash,
    repository_files_modified: repositoryFilesModified,
    commit_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: repositoryFilesModified,
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'approve_or_deny_commit_before_git_commit'
  };
}

module.exports = { createOpenCodeCommitApproval, defaultCommitApprovalId, normalizeCommitMessage };
