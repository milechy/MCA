const fs = require('node:fs');
const path = require('node:path');
const { PHASES, CONTROL_ACTIONS } = require('./types');
const { appendAuditEvent } = require('./audit-log');

const ALLOWED_TRANSITIONS = Object.freeze({
  [PHASES.IDLE]: [PHASES.PLANNING, PHASES.PAUSED],
  [PHASES.PLANNING]: [PHASES.RISK_ASSESSMENT, PHASES.BLOCKED, PHASES.STOPPED_SECURITY],
  [PHASES.RISK_ASSESSMENT]: [PHASES.PLAN_APPROVAL_PENDING, PHASES.EXECUTING, PHASES.ESCALATED, PHASES.STOPPED_SECURITY],
  [PHASES.PLAN_APPROVAL_PENDING]: [PHASES.EXECUTING, PHASES.PLANNING, PHASES.BLOCKED, PHASES.PAUSED, PHASES.ESCALATED, PHASES.STOPPED_SECURITY],
  [PHASES.EXECUTING]: [PHASES.GATE_RUNNING, PHASES.DIFF_APPROVAL_PENDING, PHASES.BLOCKED, PHASES.ESCALATED, PHASES.STOPPED_SECURITY],
  [PHASES.GATE_RUNNING]: [PHASES.GATE_FAILED, PHASES.DIFF_APPROVAL_PENDING, PHASES.COMMITTING, PHASES.ESCALATED, PHASES.STOPPED_SECURITY],
  [PHASES.GATE_FAILED]: [PHASES.DEBUGGING, PHASES.BLOCKED, PHASES.ESCALATED, PHASES.STOPPED_SECURITY],
  [PHASES.DEBUGGING]: [PHASES.GATE_RUNNING, PHASES.BLOCKED, PHASES.ESCALATED, PHASES.STOPPED_SECURITY],
  [PHASES.DIFF_APPROVAL_PENDING]: [PHASES.COMMITTING, PHASES.PLANNING, PHASES.BLOCKED, PHASES.PAUSED, PHASES.ESCALATED, PHASES.STOPPED_SECURITY],
  [PHASES.COMMITTING]: [PHASES.DONE, PHASES.ESCALATED, PHASES.STOPPED_SECURITY],
  [PHASES.DONE]: [PHASES.IDLE, PHASES.PLANNING],
  [PHASES.PAUSED]: [PHASES.IDLE, PHASES.STOPPED_SECURITY],
  [PHASES.BLOCKED]: [PHASES.PLANNING, PHASES.PAUSED, PHASES.ESCALATED, PHASES.STOPPED_SECURITY],
  [PHASES.ESCALATED]: [PHASES.PLANNING, PHASES.PAUSED, PHASES.STOPPED_SECURITY],
  [PHASES.STOPPED_SECURITY]: []
});

const CONTROL_DECISION_PHASES = Object.freeze({
  [CONTROL_ACTIONS.AUTO_EXECUTE]: PHASES.EXECUTING,
  [CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL]: PHASES.PLAN_APPROVAL_PENDING,
  [CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL]: PHASES.DIFF_APPROVAL_PENDING,
  [CONTROL_ACTIONS.STOP]: PHASES.STOPPED_SECURITY,
  [CONTROL_ACTIONS.ESCALATE]: PHASES.ESCALATED
});

const PLAN_APPROVAL_REASONS = Object.freeze([
  'approval_mode_risk_threshold',
  'fullauto_high_risk_threshold',
  'production_risk_requires_plan_approval',
  'mode_change_requires_plan_approval',
  'resume_after_security_stop_requires_plan_approval'
]);

const DIFF_APPROVAL_REASONS = Object.freeze([
  'diff_approval_required'
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function loadState(rootDir = process.cwd()) {
  return readJson(path.join(rootDir, '.ralph', 'state.json'));
}

function saveState(state, rootDir = process.cwd()) {
  writeJson(path.join(rootDir, '.ralph', 'state.json'), {
    ...state,
    updated_at: new Date().toISOString()
  });
}

function canTransition(fromPhase, toPhase) {
  return Boolean(ALLOWED_TRANSITIONS[fromPhase]?.includes(toPhase));
}

function transitionState(toPhase, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const state = options.state || loadState(rootDir);
  const fromPhase = state.phase;

  if (!canTransition(fromPhase, toPhase)) {
    throw new Error(`Invalid Ralph transition: ${fromPhase} -> ${toPhase}`);
  }

  const nextState = {
    ...state,
    phase: toPhase,
    current_approval_id: options.current_approval_id ?? state.current_approval_id ?? null,
    control_decision: options.control_decision ?? state.control_decision ?? null,
    security_stop: toPhase === PHASES.STOPPED_SECURITY ? true : state.security_stop,
    escalated: toPhase === PHASES.ESCALATED ? true : state.escalated
  };

  saveState(nextState, rootDir);
  appendAuditEvent({
    event: 'state_transition',
    from: fromPhase,
    to: toPhase,
    reason: options.reason || null,
    control_decision: options.control_decision || null
  }, { filePath: path.join(rootDir, '.ralph', 'logs', 'audit.jsonl') });

  return nextState;
}

function phaseForControlDecision(decision) {
  return CONTROL_DECISION_PHASES[decision?.action] || PHASES.BLOCKED;
}

function explainApprovalPending(decision) {
  const reason = decision?.reason || null;
  if (phaseForControlDecision(decision) === PHASES.PLAN_APPROVAL_PENDING) {
    return {
      phase: PHASES.PLAN_APPROVAL_PENDING,
      reason,
      known_reason: PLAN_APPROVAL_REASONS.includes(reason),
      requires_plan_approval: true,
      requires_diff_approval: false
    };
  }
  if (phaseForControlDecision(decision) === PHASES.DIFF_APPROVAL_PENDING) {
    return {
      phase: PHASES.DIFF_APPROVAL_PENDING,
      reason,
      known_reason: DIFF_APPROVAL_REASONS.includes(reason),
      requires_plan_approval: false,
      requires_diff_approval: true
    };
  }
  return {
    phase: phaseForControlDecision(decision),
    reason,
    known_reason: false,
    requires_plan_approval: false,
    requires_diff_approval: false
  };
}

function transitionForControlDecision(decision, options = {}) {
  const toPhase = phaseForControlDecision(decision);
  if (toPhase === PHASES.STOPPED_SECURITY) {
    return triggerSecurityStop(decision.reason, { ...options, control_decision: decision });
  }
  return transitionState(toPhase, { ...options, reason: decision.reason, control_decision: decision });
}

function triggerSecurityStop(reason, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const state = options.state || loadState(rootDir);
  const stoppedState = {
    ...state,
    phase: PHASES.STOPPED_SECURITY,
    security_stop: true,
    blocked_reason: reason,
    control_decision: options.control_decision || state.control_decision || null,
    updated_at: new Date().toISOString()
  };
  saveState(stoppedState, rootDir);
  appendAuditEvent({ event: 'security_stop', reason, control_decision: options.control_decision || null }, { filePath: path.join(rootDir, '.ralph', 'logs', 'audit.jsonl') });
  return stoppedState;
}

module.exports = {
  ALLOWED_TRANSITIONS,
  CONTROL_DECISION_PHASES,
  PLAN_APPROVAL_REASONS,
  DIFF_APPROVAL_REASONS,
  loadState,
  saveState,
  canTransition,
  transitionState,
  phaseForControlDecision,
  explainApprovalPending,
  transitionForControlDecision,
  triggerSecurityStop
};
