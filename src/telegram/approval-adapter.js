const { dryRunApprovalCommand } = require('../ralph/approval-validator');
const { approveApprovalRecordOnly, denyApproval, supersedeApprovalForModify } = require('../ralph/approval-manager');
const { summarizeApproval } = require('../ralph/approval-reader');

function failure(action, validation) {
  return {
    ok: false,
    action,
    reason: validation.reason,
    validation,
    wired_to_runtime: false
  };
}

function approveFromTelegram(approvalId, userId, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const validation = dryRunApprovalCommand('approve', approvalId, userId, { rootDir });
  if (!validation.ok) return failure('approve', validation);

  const approval = approveApprovalRecordOnly(approvalId, userId, { rootDir, channel: 'telegram' });
  return {
    ok: true,
    action: 'approve',
    approval: summarizeApproval(approval),
    wired_to_runtime: false,
    execution_connected: false,
    execution_requires_hash_verification: true
  };
}

function denyFromTelegram(approvalId, userId, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const validation = dryRunApprovalCommand('deny', approvalId, userId, { rootDir });
  if (!validation.ok) return failure('deny', validation);

  const approval = denyApproval(approvalId, userId, { rootDir, channel: 'telegram' });
  return {
    ok: true,
    action: 'deny',
    approval: summarizeApproval(approval),
    wired_to_runtime: false,
    execution_connected: false
  };
}

function modifyFromTelegram(approvalId, userId, instruction, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const validation = dryRunApprovalCommand('modify', approvalId, userId, { rootDir });
  if (!validation.ok) return failure('modify', validation);

  const approval = supersedeApprovalForModify(approvalId, instruction, { rootDir, channel: 'telegram' });
  return {
    ok: true,
    action: 'modify',
    approval: summarizeApproval(approval),
    instruction,
    next_action: 'REPLAN_REQUIRED',
    wired_to_runtime: false,
    execution_connected: false
  };
}

module.exports = {
  approveFromTelegram,
  denyFromTelegram,
  modifyFromTelegram
};
