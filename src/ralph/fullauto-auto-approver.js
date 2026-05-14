const { readApproval, approveApprovalRecordOnly } = require('./approval-manager');
const { loadMode } = require('./mode-manager');
const { APPROVAL_STATUSES, APPROVAL_TYPES } = require('./types');

const AUTOAPPROVER_VERSION = 'fullauto_auto_approver_v0_1';

const FULLAUTO_AUTO_APPROVABLE_TYPES = new Set([
  APPROVAL_TYPES.DIFF,
  'commit',
  'push',
  'pr'
]);

// Some legacy approval creators in src/telegram/opencode-*-approval.js stamp
// approval_type='plan' on records that are operationally push or PR approvals.
// We derive the real gate kind from the approval_id prefix so the auto-approver
// can recognize them; this is additive and never widens the type allow-list.
const APPROVAL_ID_GATE_KIND = [
  { prefix: 'APR-OPENCODE-APPLY-', kind: APPROVAL_TYPES.DIFF },
  { prefix: 'APR-OPENCODE-AUTO-', kind: APPROVAL_TYPES.DIFF },
  { prefix: 'APR-OPENCODE-COMMIT-', kind: 'commit' },
  { prefix: 'APR-OPENCODE-PUSH-', kind: 'push' },
  { prefix: 'APR-OPENCODE-PR-', kind: 'pr' }
];

function deriveGateKind(approval) {
  const literalType = String(approval && approval.approval_type || '').toLowerCase();
  if (FULLAUTO_AUTO_APPROVABLE_TYPES.has(literalType)) return literalType;
  const id = String(approval && approval.approval_id || '');
  for (const { prefix, kind } of APPROVAL_ID_GATE_KIND) {
    if (id.startsWith(prefix)) return kind;
  }
  return literalType;
}

function readModeSafely(rootDir, { now = new Date() } = {}) {
  try {
    const mode = loadMode(rootDir);
    if (!mode || mode.mode !== 'fullauto') return { mode: mode && mode.mode ? mode.mode : 'approval', expired: false };
    if (mode.effective_until && new Date(mode.effective_until).getTime() < now.getTime()) {
      return { mode: 'approval', expired: true, was_fullauto: true };
    }
    return { mode: 'fullauto', expired: false };
  } catch {
    return { mode: 'approval', expired: false };
  }
}

function maybeAutoApproveForFullauto({ rootDir, story = {}, now = new Date() } = {}) {
  const approvalId = story && story.current_approval_id;
  if (!approvalId) return { ok: true, approved: false, reason: 'no_pending_approval' };

  const modeState = readModeSafely(rootDir, { now });
  if (modeState.mode !== 'fullauto') {
    return { ok: true, approved: false, reason: modeState.expired ? 'fullauto_expired_revert_to_approval' : 'mode_not_fullauto' };
  }

  let approval;
  try {
    approval = readApproval(rootDir, approvalId);
  } catch {
    return { ok: false, approved: false, reason: 'approval_not_readable', approval_id: approvalId };
  }

  if (approval.status === APPROVAL_STATUSES.APPROVED) {
    return { ok: true, approved: false, reason: 'already_approved', approval_id: approvalId };
  }
  if (approval.status !== APPROVAL_STATUSES.PENDING) {
    return { ok: true, approved: false, reason: `approval_status_${approval.status}`, approval_id: approvalId };
  }
  if (approval.expires_at && new Date(approval.expires_at).getTime() < now.getTime()) {
    return { ok: true, approved: false, reason: 'approval_expired', approval_id: approvalId };
  }

  const approvalType = String(approval.approval_type || '').toLowerCase();
  const gateKind = deriveGateKind(approval);
  if (!FULLAUTO_AUTO_APPROVABLE_TYPES.has(gateKind)) {
    return { ok: true, approved: false, reason: `approval_type_${approvalType || 'unknown'}_requires_human`, approval_id: approvalId };
  }

  const risk = approval.risk || story.last_risk || story.risk || { score: 0 };
  const riskScore = Number.isFinite(risk.score) ? risk.score : 0;
  if (riskScore >= 5) {
    return { ok: true, approved: false, reason: 'risk_5_security_stop', approval_id: approvalId, risk_score: riskScore };
  }

  const targetEnv = String(story.target_env || approval.target_env || 'local');
  if (targetEnv === 'production' && riskScore >= 3) {
    return { ok: true, approved: false, reason: 'production_high_risk_requires_human', approval_id: approvalId, risk_score: riskScore, target_env: targetEnv };
  }

  if (riskScore >= 4) {
    return { ok: true, approved: false, reason: 'fullauto_high_risk_threshold', approval_id: approvalId, risk_score: riskScore };
  }

  try {
    const result = approveApprovalRecordOnly(approvalId, 0, { rootDir, channel: 'fullauto-auto' });
    if (!result || result.status !== APPROVAL_STATUSES.APPROVED) {
      return { ok: false, approved: false, reason: 'approve_record_only_failed', approval_id: approvalId, status: result && result.status };
    }
    return {
      ok: true,
      approved: true,
      reason: 'fullauto_auto_approved',
      approval_id: approvalId,
      approval_type: approvalType,
      risk_score: riskScore,
      mode: 'fullauto',
      version: AUTOAPPROVER_VERSION
    };
  } catch (error) {
    return { ok: false, approved: false, reason: 'approve_record_only_threw', approval_id: approvalId, error_preview: String(error && error.message ? error.message : error).slice(0, 240) };
  }
}

module.exports = {
  AUTOAPPROVER_VERSION,
  FULLAUTO_AUTO_APPROVABLE_TYPES,
  APPROVAL_ID_GATE_KIND,
  deriveGateKind,
  readModeSafely,
  maybeAutoApproveForFullauto
};
