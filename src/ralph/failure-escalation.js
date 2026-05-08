const { appendAuditEvent } = require('./audit-log');
const { PHASES } = require('./types');

const ESCALATION_REASONS = Object.freeze({
  RISK_5: 'risk_5_security_stop',
  SECRET_POLICY: 'secret_policy_violation',
  PRODUCTION_DB: 'production_db_protection_violation',
  RLS_AUTH: 'rls_or_auth_violation',
  GATE_FAILURE: 'gate_failure',
  UNEXPECTED_EXECUTION: 'unexpected_execution',
  WORKTREE_DIRTY: 'working_tree_dirty_after_cleanup'
});

function oneLine(value, maxLength = 240) {
  const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function buildFailureEscalation({ reason, story_id, approval_id, agent_id, diff_hash, evidence } = {}) {
  const normalizedReason = Object.values(ESCALATION_REASONS).includes(reason) ? reason : 'human_escalation_required';
  const stopNow = [
    ESCALATION_REASONS.RISK_5,
    ESCALATION_REASONS.SECRET_POLICY,
    ESCALATION_REASONS.PRODUCTION_DB,
    ESCALATION_REASONS.RLS_AUTH,
    ESCALATION_REASONS.UNEXPECTED_EXECUTION
  ].includes(normalizedReason);

  return {
    ok: true,
    stage: 'failure_escalation',
    reason: normalizedReason,
    target_phase: stopNow ? PHASES.STOPPED_SECURITY : PHASES.ESCALATED,
    story_id: story_id || null,
    approval_id: approval_id || null,
    agent_id: agent_id || null,
    diff_hash: diff_hash || null,
    actions: {
      stop_current_story: true,
      stop_agent_process: true,
      stop_secret_injection: true,
      preserve_git_diff: true,
      preserve_audit_log: true,
      notify_telegram: true,
      notify_dashboard: true,
      require_human_to_resume: true
    },
    deploy_allowed: false,
    migration_allowed: false,
    merge_allowed: false,
    push_allowed: false,
    unrestricted_shell_allowed: false,
    evidence_preview: oneLine(JSON.stringify(evidence || {})),
    next_action: stopNow ? 'security_stop_until_human_resume_approval' : 'human_review_required_before_resume'
  };
}

function recordFailureEscalation(escalation, { rootDir = process.cwd() } = {}) {
  return appendAuditEvent({
    event: 'failure_escalation',
    reason: escalation.reason,
    target_phase: escalation.target_phase,
    story_id: escalation.story_id,
    approval_id: escalation.approval_id,
    agent_id: escalation.agent_id,
    actions: escalation.actions
  }, { rootDir });
}

module.exports = { ESCALATION_REASONS, buildFailureEscalation, recordFailureEscalation };
