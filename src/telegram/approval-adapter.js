const { dryRunApprovalCommand } = require('../ralph/approval-validator');
const { approveApprovalRecordOnly, denyApproval, supersedeApprovalForModify } = require('../ralph/approval-manager');
const { summarizeApproval } = require('../ralph/approval-reader');
const { requestResumeApproval, findApprovedResumeApproval } = require('../ralph/resume-after-security-stop');
const { readStory } = require('../ralph/story-queue');

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

function resumeRequestFromTelegram({ story_id, requester_user_id, rationale, options = {} } = {}) {
  const rootDir = options.rootDir || process.cwd();
  const result = requestResumeApproval({
    rootDir,
    story_id,
    requester_user_id,
    rationale,
    now: options.now || new Date()
  });
  return {
    ok: result.ok === true,
    action: 'resume_request',
    reason: result.reason || null,
    approval_id: result.approval_id || null,
    story_id: result.story_id || story_id || null,
    approval_type: result.approval_type || null,
    expires_at: result.expires_at || null,
    requested_by: result.requested_by || null,
    rationale_preview: result.rationale_preview || null,
    next_action: result.next_action || 'admin_must_confirm_resume_via_approve_command',
    wired_to_runtime: result.ok === true,
    execution_connected: false
  };
}

function resumeStatusFromTelegram({ story_id, options = {} } = {}) {
  const rootDir = options.rootDir || process.cwd();
  let story;
  try { story = readStory(rootDir, story_id); }
  catch { return { ok: false, action: 'resume_status', reason: 'story_not_found', story_id: story_id || null, wired_to_runtime: false }; }
  const approval = findApprovedResumeApproval(rootDir, story_id, { now: options.now || new Date() });
  return {
    ok: true,
    action: 'resume_status',
    story_id,
    current_phase: story.current_phase,
    story_status: story.status,
    is_security_stopped: ['STOPPED_SECURITY', 'STOPPED'].includes(story.current_phase) || ['failed', 'stopped'].includes(story.status),
    last_resume_approval_id: story.last_resume_approval_id || null,
    last_resume_rationale_preview: (story.last_resume_rationale || '').slice(0, 240) || null,
    pending_approved_resume_approval_id: approval ? approval.approval_id : null,
    pending_approved_resume_expires_at: approval ? approval.expires_at : null,
    wired_to_runtime: false,
    execution_connected: false
  };
}

module.exports = {
  approveFromTelegram,
  denyFromTelegram,
  modifyFromTelegram,
  resumeRequestFromTelegram,
  resumeStatusFromTelegram
};
