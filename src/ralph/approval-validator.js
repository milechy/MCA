const { getApproval, summarizeApproval } = require('./approval-reader');

function validateApprovalForDryRun(approvalId, userId, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const approval = getApproval(approvalId, { rootDir });

  if (!approval) {
    return { ok: false, reason: 'approval_not_found', approval_id: approvalId };
  }

  if (approval.status !== 'pending') {
    return {
      ok: false,
      reason: `approval_status_${approval.status}`,
      approval: summarizeApproval(approval)
    };
  }

  if (new Date(approval.expires_at).getTime() < Date.now()) {
    return {
      ok: false,
      reason: 'approval_expired',
      approval: summarizeApproval(approval)
    };
  }

  if (Array.isArray(approval.allowed_user_ids) && approval.allowed_user_ids.length > 0 && !approval.allowed_user_ids.includes(userId)) {
    return {
      ok: false,
      reason: 'user_not_allowed',
      user_id: userId,
      approval: summarizeApproval(approval)
    };
  }

  return {
    ok: true,
    approval: summarizeApproval(approval)
  };
}

function dryRunApprovalCommand(action, approvalId, userId, options = {}) {
  const validation = validateApprovalForDryRun(approvalId, userId, options);
  if (!validation.ok) {
    return {
      ok: false,
      action,
      reason: validation.reason,
      validation
    };
  }

  return {
    ok: true,
    action,
    would: action,
    runtime_mutation: false,
    approval: validation.approval
  };
}

module.exports = {
  validateApprovalForDryRun,
  dryRunApprovalCommand
};
