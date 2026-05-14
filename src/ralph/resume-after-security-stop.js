const fs = require('node:fs');
const path = require('node:path');

const { createApproval, readApproval } = require('./approval-manager');
const { loadMode } = require('./mode-manager');
const { readStory, updateStory } = require('./story-queue');
const { APPROVAL_STATUSES, APPROVAL_TYPES } = require('./types');
const { appendAuditEvent } = require('./audit-log');

const RESUME_VERSION = 'resume_after_security_stop_v0_1';
const STOPPED_SECURITY_PHASE = 'STOPPED_SECURITY';
const LOOP_STOPPED_PHASE = 'STOPPED';
const MAX_RATIONALE_CHARS = 4000;
const RESUME_APPROVAL_ID_PREFIX = 'APR-RESUME-';
const DEFAULT_EXPIRES_HOURS = 4;
const MAX_EXPIRES_HOURS = 12;

const ROLES_FILE_PATH = (rootDir) => path.join(rootDir, '.ralph', 'roles.json');
const AUDIT_PATH = (rootDir) => path.join(rootDir, '.ralph', 'logs', 'audit.jsonl');

function oneLine(value, maxLength = MAX_RATIONALE_CHARS) {
  return String(value || '').replace(/\r/g, '').replace(/[\t]+/g, ' ').replace(/[ \t]+\n/g, '\n').trim().slice(0, maxLength);
}

function redactRationale(value) {
  return oneLine(value, MAX_RATIONALE_CHARS)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/(password|passwd|secret|token|api[_-]?key|service_role)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/sk-or-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENROUTER_KEY]');
}

function loadRoles(rootDir) {
  try {
    return JSON.parse(fs.readFileSync(ROLES_FILE_PATH(rootDir), 'utf8'));
  } catch {
    return null;
  }
}

function isAdmin(rootDir, userId) {
  const roles = loadRoles(rootDir);
  if (!roles) return false;
  const id = Number(userId);
  if (!Number.isFinite(id)) return false;
  const admins = Array.isArray(roles.admin_user_ids) ? roles.admin_user_ids : [];
  const owners = Array.isArray(roles.owner_user_ids) ? roles.owner_user_ids : [];
  return admins.includes(id) || owners.includes(id);
}

function isStopped(story) {
  if (!story) return false;
  return story.current_phase === STOPPED_SECURITY_PHASE
    || story.current_phase === LOOP_STOPPED_PHASE
    || story.status === 'stopped'
    || story.status === 'failed';
}

function resumeApprovalId(storyId, now = new Date()) {
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const safeId = String(storyId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `${RESUME_APPROVAL_ID_PREFIX}${safeId || 'UNKNOWN'}-${stamp}`;
}

function requestResumeApproval({ rootDir = process.cwd(), story_id, requester_user_id, rationale = '', expires_hours = DEFAULT_EXPIRES_HOURS, now = new Date() } = {}) {
  if (!story_id) return { ok: false, reason: 'story_id_required' };
  if (!Number.isFinite(Number(requester_user_id))) return { ok: false, reason: 'requester_user_id_required' };
  if (!isAdmin(rootDir, requester_user_id)) return { ok: false, reason: 'admin_required' };

  let story;
  try {
    story = readStory(rootDir, story_id);
  } catch {
    return { ok: false, reason: 'story_not_found', story_id };
  }
  if (!isStopped(story)) {
    return { ok: false, reason: 'story_not_in_security_stop_state', story_id, current_phase: story.current_phase, status: story.status };
  }

  const safeRationale = redactRationale(rationale);
  if (safeRationale.length < 8) {
    return { ok: false, reason: 'rationale_too_short_min_8_chars' };
  }
  const hours = Number.isFinite(Number(expires_hours)) ? Math.max(1, Math.min(MAX_EXPIRES_HOURS, Number(expires_hours))) : DEFAULT_EXPIRES_HOURS;
  const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();

  const approvalId = resumeApprovalId(story_id, now);
  const plan = {
    story_id,
    objective: oneLine(`Resume after security stop: ${safeRationale}`, 600),
    requested_paths: Array.isArray(story.requested_paths) ? story.requested_paths : [],
    resume_after_security_stop: true,
    rationale: safeRationale,
    previous_blocked_reason: story.blocked_reason || null
  };
  const risk = { score: 0, category: 'low', label: 'RISK_RESUME_REQUEST', requires_approval: true };

  let approval;
  try {
    approval = createApproval(plan, risk, {
      rootDir,
      approval_id: approvalId,
      approval_type: APPROVAL_TYPES.RESUME_AFTER_SECURITY_STOP,
      requested_action: 'resume_after_security_stop',
      allowed_user_ids: [],
      expires_at: expiresAt
    });
  } catch (error) {
    return { ok: false, reason: 'approval_create_failed', approval_id: approvalId, error_preview: oneLine(error && error.message ? error.message : String(error), 240) };
  }

  appendAuditEvent({
    event: 'resume_request_recorded',
    approval_id: approvalId,
    story_id,
    requested_by: `cli:${requester_user_id}`,
    expires_at: expiresAt,
    rationale_preview: oneLine(safeRationale, 240)
  }, { filePath: AUDIT_PATH(rootDir) });

  return {
    ok: true,
    stage: 'resume_request',
    version: RESUME_VERSION,
    approval_id: approvalId,
    story_id,
    expires_at: expiresAt,
    requested_by: `cli:${requester_user_id}`,
    approval_type: APPROVAL_TYPES.RESUME_AFTER_SECURITY_STOP,
    rationale_preview: oneLine(safeRationale, 240),
    next_action: 'admin_must_confirm_resume_via_cli_approve'
  };
}

function findApprovedResumeApproval(rootDir, story_id, { now = new Date() } = {}) {
  const pendingDir = path.join(rootDir, '.ralph', 'approval-pending');
  if (!fs.existsSync(pendingDir)) return null;
  const safeStoryId = String(story_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (!safeStoryId) return null;
  const entries = fs.readdirSync(pendingDir).filter((name) => name.startsWith(`${RESUME_APPROVAL_ID_PREFIX}${safeStoryId}-`) && name.endsWith('.json'));
  for (const entry of entries) {
    try {
      const approval = JSON.parse(fs.readFileSync(path.join(pendingDir, entry), 'utf8'));
      if (approval.status !== APPROVAL_STATUSES.APPROVED) continue;
      if (new Date(approval.expires_at).getTime() < now.getTime()) continue;
      if (approval.approval_type !== APPROVAL_TYPES.RESUME_AFTER_SECURITY_STOP) continue;
      if (approval.story_id && approval.story_id !== story_id) continue;
      return approval;
    } catch {
      continue;
    }
  }
  return null;
}

function consumeApprovedResume({ rootDir = process.cwd(), story_id, now = new Date() } = {}) {
  if (!story_id) return { ok: false, reason: 'story_id_required' };

  let story;
  try {
    story = readStory(rootDir, story_id);
  } catch {
    return { ok: false, reason: 'story_not_found', story_id };
  }
  if (!isStopped(story)) {
    return { ok: false, reason: 'story_not_in_security_stop_state', current_phase: story.current_phase, status: story.status };
  }
  const mode = (() => { try { return loadMode(rootDir); } catch { return null; } })();
  if (mode && mode.mode === 'fullauto') {
    // We do not auto-resume in fullauto. RESUME_AFTER_SECURITY_STOP is an
    // explicit out-of-band trust escalation; the loop only acts on it after
    // a human-flipped APPROVED record. (We still allow consumption here for
    // operational completeness; fullauto-auto-approver is what is forbidden
    // from flipping these to APPROVED.)
  }

  const approval = findApprovedResumeApproval(rootDir, story_id, { now });
  if (!approval) return { ok: false, reason: 'no_approved_resume_approval_found' };

  // Mark the approval as EXECUTED so it cannot be reused.
  try {
    approval.status = APPROVAL_STATUSES.EXECUTED;
    approval.executed_at = now.toISOString();
    const approvalPath = path.join(rootDir, '.ralph', 'approval-pending', `${approval.approval_id}.json`);
    fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
    fs.writeFileSync(approvalPath, `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  } catch (error) {
    return { ok: false, reason: 'approval_finalize_failed', error_preview: oneLine(error && error.message ? error.message : String(error), 240) };
  }

  // Move the story back to PLAN_APPROVAL_PENDING so the next tick re-runs risk
  // assessment with the resume rationale in context.
  let updated;
  try {
    updated = updateStory(story_id, {
      status: 'queued',
      current_phase: 'PLAN_APPROVAL_PENDING',
      current_approval_id: null,
      blocked_reason: null,
      retry_after_at: null,
      attempts: 0,
      last_resume_approval_id: approval.approval_id,
      last_resume_rationale: oneLine(approval.plan && approval.plan.rationale ? approval.plan.rationale : '', 1000)
    }, { rootDir, now, event: 'resumed_after_security_stop' });
  } catch (error) {
    return { ok: false, reason: 'story_update_failed', error_preview: oneLine(error && error.message ? error.message : String(error), 240) };
  }

  appendAuditEvent({
    event: 'resume_after_security_stop_consumed',
    approval_id: approval.approval_id,
    story_id,
    transitioned_to: 'PLAN_APPROVAL_PENDING',
    approved_by: approval.approved_by || null
  }, { filePath: AUDIT_PATH(rootDir) });

  return {
    ok: true,
    stage: 'resume_consume',
    version: RESUME_VERSION,
    story_id,
    approval_id: approval.approval_id,
    from_phase: story.current_phase,
    to_phase: 'PLAN_APPROVAL_PENDING',
    transitioned: true,
    story: updated.summary || null,
    rationale_preview: oneLine(approval.plan && approval.plan.rationale ? approval.plan.rationale : '', 240),
    next_action: 'plan_approval_pending_re_evaluation_required'
  };
}

module.exports = {
  RESUME_VERSION,
  RESUME_APPROVAL_ID_PREFIX,
  STOPPED_SECURITY_PHASE,
  LOOP_STOPPED_PHASE,
  DEFAULT_EXPIRES_HOURS,
  MAX_EXPIRES_HOURS,
  isAdmin,
  isStopped,
  redactRationale,
  resumeApprovalId,
  requestResumeApproval,
  findApprovedResumeApproval,
  consumeApprovedResume
};
