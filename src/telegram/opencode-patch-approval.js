const fs = require('node:fs');
const path = require('node:path');
const { sha256, calculatePlanHash, calculateDiffHash } = require('../ralph/hash');
const { APPROVAL_TYPES, APPROVAL_STATUSES } = require('../ralph/types');
const { createApproval } = require('../ralph/approval-manager');
const { assertSandboxLocalPath } = require('./opencode-sandbox-runner');

function defaultPatchApprovalId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').slice(0, 14);
  return `APR-OPENCODE-PATCH-${stamp}`;
}

function calculatePatchHash(rootDir, preview) {
  if (!preview?.candidate_patch_path) return null;
  const patchPath = path.isAbsolute(preview.candidate_patch_path)
    ? preview.candidate_patch_path
    : path.join(rootDir, preview.candidate_patch_path);
  if (!preview.sandbox_root || !assertSandboxLocalPath(rootDir, preview.sandbox_root, patchPath)) return null;
  if (!fs.existsSync(patchPath)) return null;
  return sha256(fs.readFileSync(patchPath));
}

function makePatchApprovalPlan(preview, patchHash) {
  return {
    story_id: `STORY-${preview.approval_id}`,
    objective: 'Approve OpenCode candidate patch preview before any apply phase',
    summary: 'OpenCode candidate patch preview approval',
    requested_action: 'opencode_candidate_patch_apply',
    candidate_patch_path: preview.candidate_patch_path,
    sandbox_root: preview.sandbox_root,
    patch_hash: patchHash,
    files_touched: preview.files_touched || [],
    risk: preview.risk,
    apply_allowed: false,
    execution_connected: false
  };
}

function makeBlockedResult(reason, preview = null) {
  return {
    ok: false,
    reason,
    stage: 'opencode_patch_preview_approval',
    approval: null,
    approval_id: null,
    patch_hash: null,
    preview_ok: preview?.ok === true,
    apply_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_patch_preview_before_approval'
  };
}

function createOpenCodePatchPreviewApproval(preview, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const now = options.now || new Date();
  if (!preview) return makeBlockedResult('candidate_preview_required', preview);
  if (preview.ok !== true) return makeBlockedResult('candidate_preview_not_ok', preview);
  if (preview.requires_approval !== true) return makeBlockedResult('candidate_preview_does_not_require_approval', preview);
  if (preview.apply_allowed !== false) return makeBlockedResult('candidate_preview_apply_must_be_disabled', preview);
  if (preview.risk?.score >= 5) return makeBlockedResult('candidate_preview_blocked_risk', preview);

  const patchHash = calculatePatchHash(rootDir, preview);
  if (!patchHash) return makeBlockedResult('patch_hash_unavailable', preview);

  const approvalId = options.approval_id || defaultPatchApprovalId(now);
  const allowedUserIds = options.allowed_user_ids || [];
  const plan = makePatchApprovalPlan(preview, patchHash);
  const approval = createApproval(plan, preview.risk, {
    rootDir,
    approval_id: approvalId,
    approval_type: APPROVAL_TYPES.DIFF,
    requested_action: 'opencode_candidate_patch_apply',
    allowed_user_ids: allowedUserIds,
    expires_at: options.expires_at,
    pre_exec_diff_hash: options.pre_apply_diff_hash || calculateDiffHash(rootDir)
  });

  approval.status = APPROVAL_STATUSES.PENDING;
  approval.patch_hash = patchHash;
  approval.candidate_patch_path = preview.candidate_patch_path;
  approval.sandbox_root = preview.sandbox_root;
  approval.files_touched = preview.files_touched || [];
  approval.blocked_paths = preview.blocked_paths || [];
  approval.diff_bytes = preview.diff_bytes;
  approval.requires_approval = true;
  approval.apply_allowed = false;
  approval.execution_connected = false;
  approval.future_apply_requires_patch_hash = true;
  approval.future_apply_requires_pre_apply_diff_hash = true;
  approval.commands_executed = [];
  approval.files_modified = [];
  approval.repository_files_modified = [];
  approval.commit_created = false;
  approval.push_performed = false;
  approval.deploy_performed = false;
  approval.migration_performed = false;

  const approvalPath = path.join(rootDir, '.ralph', 'approval-pending', `${approval.approval_id}.json`);
  fs.writeFileSync(approvalPath, `${JSON.stringify(approval, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    reason: null,
    stage: 'opencode_patch_preview_approval',
    approval,
    approval_id: approval.approval_id,
    patch_hash: patchHash,
    plan_hash: approval.plan_hash,
    pre_apply_diff_hash: approval.pre_exec_diff_hash,
    approval_type: approval.approval_type,
    status: approval.status,
    requested_action: approval.requested_action,
    preview_ok: true,
    risk: approval.risk,
    requires_approval: true,
    apply_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'approve_or_deny_patch_preview_before_any_apply_phase'
  };
}

module.exports = {
  defaultPatchApprovalId,
  calculatePatchHash,
  makePatchApprovalPlan,
  createOpenCodePatchPreviewApproval
};
