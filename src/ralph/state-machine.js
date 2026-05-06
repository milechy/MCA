const fs = require('node:fs');
const path = require('node:path');
const { PHASES, CONTROL_ACTIONS } = require('./types');
const { appendAuditEvent } = require('./audit-log');

const ALLOWED_TRANSITIONS = Object.freeze({
  [PHASES.IDLE]: [PHASES.PLANNING, PHASES.PAUSED],
  [PHASES.PLANNING]: [PHASES.RISK_ASSESSMENT, PHASES.BLOCKED, PHASES.STOPPED_SECURITY],
  [PHASES.RISK_ASSESSMENT]: [PHASES.PLAN_APPROVAL_PENDING, PHASES.EXECUTING, PHASES.STOPPED_SECURITY],
  [PHASES.PLAN_APPROVAL_PENDING]: [PHASES.EXECUTING, PHASES.PLANNING, PHASES.BLOCKED, PHASES.PAUSED],
  [PHASES.EXECUTING]: [PHASES.GATE_RUNNING, PHASES.STOPPED_SECURITY, PHASES.BLOCKED],
  [PHASES.GATE_RUNNING]: [PHASES.GATE_FAILED, PHASES.DIFF_APPROVAL_PENDING, PHASES.COMMITTING, PHASES.STOPPED_SECURITY],
  [PHASES.GATE_FAILED]: [PHASES.DEBUGGING, PHASES.BLOCKED, PHASES.STOPPED_SECURITY],
  [PHASES.DEBUGGING]: [PHASES.GATE_RUNNING, PHASES.BLOCKED, PHASES.STOPPED_SECURITY],
  [PHASES.DIFF_APPROVAL_PENDING]: [PHASES.COMMITTING, PHASES.PLANNING, PHASES.BLOCKED, PHASES.PAUSED, PHASES.STOPPED_SECURITY],
  [PHASES.COMMITTING]: [PHASES.DONE, PHASES.STOPPED_SECURITY],
  [PHASES.DONE]: [PHASES.IDLE, PHASES.PLANNING],
  [PHASES.PAUSED]: [PHASES.IDLE, PHASES.STOPPED_SECURITY],
  [PHASES.BLOCKED]: [PHASES.PLANNING, PHASES.PAUSED, PHASES.STOPPED_SECURITY],
  [PHASES.STOPPED_SECURITY]: []
});

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
    security_stop: toPhase === PHASES.STOPPED_SECURITY ? true : state.security_stop
  };

  saveState(nextState, rootDir);
  appendAuditEvent({
    event: 'state_transition',
    from: fromPhase,
    to: toPhase,
    reason: options.reason || null
  }, { filePath: path.join(rootDir, '.ralph', 'logs', 'audit.jsonl') });

  return nextState;
}

function phaseForControlDecision(decision) {
  switch (decision.action) {
    case CONTROL_ACTIONS.AUTO_EXECUTE:
      return PHASES.EXECUTING;
    case CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL:
      return PHASES.PLAN_APPROVAL_PENDING;
    case CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL:
      return PHASES.DIFF_APPROVAL_PENDING;
    case CONTROL_ACTIONS.STOP:
      return PHASES.STOPPED_SECURITY;
    default:
      return PHASES.BLOCKED;
  }
}

function triggerSecurityStop(reason, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const state = options.state || loadState(rootDir);
  const stoppedState = {
    ...state,
    phase: PHASES.STOPPED_SECURITY,
    security_stop: true,
    blocked_reason: reason,
    updated_at: new Date().toISOString()
  };
  saveState(stoppedState, rootDir);
  appendAuditEvent({ event: 'security_stop', reason }, { filePath: path.join(rootDir, '.ralph', 'logs', 'audit.jsonl') });
  return stoppedState;
}

module.exports = {
  ALLOWED_TRANSITIONS,
  loadState,
  saveState,
  canTransition,
  transitionState,
  phaseForControlDecision,
  triggerSecurityStop
};
