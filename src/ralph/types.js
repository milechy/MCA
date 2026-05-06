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

module.exports = {
  PHASES,
  APPROVAL_TYPES,
  APPROVAL_STATUSES,
  CONTROL_ACTIONS
};
