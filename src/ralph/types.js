const PHASES = Object.freeze({
  IDLE: 'IDLE',
  PLANNING: 'PLANNING',
  RISK_ASSESSMENT: 'RISK_ASSESSMENT',
  PLAN_APPROVAL_PENDING: 'PLAN_APPROVAL_PENDING',
  EXECUTING: 'EXECUTING',
  GATE_RUNNING: 'GATE_RUNNING',
  GATE_FAILED: 'GATE_FAILED',
  DEBUGGING: 'DEBUGGING',
  DIFF_APPROVAL_PENDING: 'DIFF_APPROVAL_PENDING',
  COMMITTING: 'COMMITTING',
  DONE: 'DONE',
  PAUSED: 'PAUSED',
  BLOCKED: 'BLOCKED',
  ESCALATED: 'ESCALATED',
  STOPPED_SECURITY: 'STOPPED_SECURITY'
});

const APPROVAL_TYPES = Object.freeze({
  PLAN: 'plan',
  DIFF: 'diff',
  MIGRATION: 'migration',
  DEPLOY: 'deploy',
  MODE_CHANGE: 'mode_change',
  RESUME_AFTER_SECURITY_STOP: 'resume_after_security_stop'
});

const APPROVAL_STATUSES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXPIRED: 'expired',
  EXECUTED: 'executed',
  SUPERSEDED: 'superseded',
  REVOKED: 'revoked',
  FAILED_VERIFICATION: 'failed_verification',
  CANCELLED: 'cancelled'
});

const CONTROL_ACTIONS = Object.freeze({
  AUTO_EXECUTE: 'auto_execute',
  REQUIRE_PLAN_APPROVAL: 'require_plan_approval',
  REQUIRE_DIFF_APPROVAL: 'require_diff_approval',
  STOP: 'stop',
  ESCALATE: 'escalate'
});

const CONTROL_REASONS = Object.freeze({
  RISK_5_SECURITY_STOP: 'risk_5_security_stop',
  DIFF_APPROVAL_REQUIRED: 'diff_approval_required',
  PRODUCTION_RISK_REQUIRES_PLAN_APPROVAL: 'production_risk_requires_plan_approval',
  APPROVAL_MODE_RISK_THRESHOLD: 'approval_mode_risk_threshold',
  FULLAUTO_HIGH_RISK_THRESHOLD: 'fullauto_high_risk_threshold',
  MODE_CHANGE_REQUIRES_PLAN_APPROVAL: 'mode_change_requires_plan_approval',
  RESUME_AFTER_SECURITY_STOP_REQUIRES_PLAN_APPROVAL: 'resume_after_security_stop_requires_plan_approval',
  AUTO_EXECUTE_ALLOWED: 'risk_within_auto_execute_policy',
  HUMAN_ESCALATION_REQUIRED: 'human_escalation_required'
});

module.exports = {
  PHASES,
  APPROVAL_TYPES,
  APPROVAL_STATUSES,
  CONTROL_ACTIONS,
  CONTROL_REASONS
};
