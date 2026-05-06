const fs = require('node:fs');
const path = require('node:path');
const { APPROVAL_STATUSES, APPROVAL_TYPES } = require('./types');
const { calculatePlanHash, calculateDiffHash } = require('./hash');
const { appendAuditEvent } = require('./audit-log');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function defaultApprovalId(date = new Date()) {
  const stamp = date.toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = `${date.getUTCHours()}${date.getUTCMinutes()}${date.getUTCSeconds()}${date.getUTCMilliseconds()}`.padStart(9, '0');
  return `APR-${stamp}-${suffix}`;
}

function approvalPath(rootDir, approvalId) {
  return path.join(rootDir, '.ralph', 'approval-pending', `${approvalId}.json`);
}

function writeApproval(rootDir, approval) {
  const filePath = approvalPath(rootDir, approval.approval_id);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  return approval;
}

function readApproval(rootDir, approvalId) {
  return JSON.parse(fs.readFileSync(approvalPath(rootDir, approvalId), 'utf8'));
}

function appendApprovalLog(rootDir, event) {
  const filePath = path.join(rootDir, '.ralph', 'approval-log.jsonl');
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify({ timestamp: nowIso(), ...event })}\n`, 'utf8');
}

function createApproval(plan, risk, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const approvalId = options.approval_id || defaultApprovalId();
  const approvalType = options.approval_type || APPROVAL_TYPES.PLAN;
  const createdAt = nowIso();
  const expiresAt = options.expires_at || new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const approval = {
    approval_id: approvalId,
    approval_type: approvalType,
    story_id: plan.story_id || null,
    risk: {
      ...risk,
      requires_approval: true
    },
    plan_hash: calculatePlanHash(plan),
    pre_exec_diff_hash: options.pre_exec_diff_hash || calculateDiffHash(rootDir),
    post_exec_diff_hash: null,
    expires_at: expiresAt,
    created_at: createdAt,
    status: APPROVAL_STATUSES.PENDING,
    requested_action: options.requested_action || approvalType,
    allowed_user_ids: options.allowed_user_ids || [],
    approved_by: null,
    approved_at: null,
    plan_summary: plan.summary || plan.objective || '',
    replan_count: options.replan_count || 0
  };

  writeApproval(rootDir, approval);
  appendApprovalLog(rootDir, { approval_id: approvalId, action: 'requested', approval_type: approvalType, plan_hash: approval.plan_hash });
  appendAuditEvent({ event: 'approval_requested', approval_id: approvalId, approval_type: approvalType }, { filePath: path.join(rootDir, '.ralph', 'logs', 'audit.jsonl') });

  return approval;
}

function verifyApproval(rootDir, approval, plan, options = {}) {
  if (approval.status !== APPROVAL_STATUSES.PENDING && approval.status !== APPROVAL_STATUSES.APPROVED) {
    return { ok: false, reason: `approval_status_${approval.status}` };
  }

  if (new Date(approval.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'approval_expired' };
  }

  const currentPlanHash = calculatePlanHash(plan);
  if (currentPlanHash !== approval.plan_hash) {
    return { ok: false, reason: 'plan_hash_mismatch', expected: approval.plan_hash, actual: currentPlanHash };
  }

  if (options.verify_diff_hash) {
    const currentDiffHash = calculateDiffHash(rootDir);
    if (currentDiffHash !== approval.pre_exec_diff_hash) {
      return { ok: false, reason: 'pre_exec_diff_hash_mismatch', expected: approval.pre_exec_diff_hash, actual: currentDiffHash };
    }
  }

  return { ok: true };
}

function approveApproval(approvalId, userId, plan, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const approval = readApproval(rootDir, approvalId);

  if (approval.allowed_user_ids.length > 0 && !approval.allowed_user_ids.includes(userId)) {
    return updateApprovalStatus(rootDir, approval, APPROVAL_STATUSES.FAILED_VERIFICATION, { reason: 'user_not_allowed', user_id: userId });
  }

  const verification = verifyApproval(rootDir, approval, plan, options);
  if (!verification.ok) {
    return updateApprovalStatus(rootDir, approval, APPROVAL_STATUSES.FAILED_VERIFICATION, verification);
  }

  approval.status = APPROVAL_STATUSES.APPROVED;
  approval.approved_by = `cli:${userId}`;
  approval.approved_at = nowIso();
  writeApproval(rootDir, approval);
  appendApprovalLog(rootDir, { approval_id: approvalId, action: 'approved', approved_by: approval.approved_by });
  return approval;
}

function updateApprovalStatus(rootDir, approval, status, details = {}) {
  approval.status = status;
  approval.status_details = details;
  writeApproval(rootDir, approval);
  appendApprovalLog(rootDir, { approval_id: approval.approval_id, action: status, details });
  return approval;
}

function denyApproval(approvalId, userId, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const approval = readApproval(rootDir, approvalId);
  approval.denied_by = `cli:${userId}`;
  approval.denied_at = nowIso();
  return updateApprovalStatus(rootDir, approval, APPROVAL_STATUSES.DENIED);
}

function supersedeApprovalForModify(approvalId, instruction, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const approval = readApproval(rootDir, approvalId);
  approval.modify_instruction = instruction;
  return updateApprovalStatus(rootDir, approval, APPROVAL_STATUSES.SUPERSEDED, { instruction, next_action: 'REPLAN_REQUIRED' });
}

function expirePendingApprovals(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const pendingDir = path.join(rootDir, '.ralph', 'approval-pending');
  if (!fs.existsSync(pendingDir)) return [];

  const expired = [];
  for (const fileName of fs.readdirSync(pendingDir)) {
    if (!fileName.endsWith('.json')) continue;
    const approval = JSON.parse(fs.readFileSync(path.join(pendingDir, fileName), 'utf8'));
    if (approval.status === APPROVAL_STATUSES.PENDING && new Date(approval.expires_at).getTime() < Date.now()) {
      expired.push(updateApprovalStatus(rootDir, approval, APPROVAL_STATUSES.EXPIRED));
    }
  }
  return expired;
}

module.exports = {
  defaultApprovalId,
  createApproval,
  readApproval,
  approveApproval,
  denyApproval,
  supersedeApprovalForModify,
  verifyApproval,
  expirePendingApprovals
};
