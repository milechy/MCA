const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PHASES, CONTROL_ACTIONS, CONTROL_REASONS, APPROVAL_TYPES } = require('../../src/ralph/types');
const { saveState, loadState, canTransition, phaseForControlDecision, explainApprovalPending, transitionForControlDecision } = require('../../src/ralph/state-machine');

function tmpRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-control-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  saveState({ phase: PHASES.RISK_ASSESSMENT, current_approval_id: null, security_stop: false }, rootDir);
  return rootDir;
}

test('state machine has no WAITING_FOR_DIFF_APPROVAL phase and uses DIFF_APPROVAL_PENDING', () => {
  expect(PHASES.WAITING_FOR_DIFF_APPROVAL).toBeUndefined();
  expect(PHASES.DIFF_APPROVAL_PENDING).toBe('DIFF_APPROVAL_PENDING');
  expect(canTransition(PHASES.GATE_RUNNING, PHASES.DIFF_APPROVAL_PENDING)).toBe(true);
});

test('phaseForControlDecision maps explicit control actions', () => {
  expect(phaseForControlDecision({ action: CONTROL_ACTIONS.AUTO_EXECUTE })).toBe(PHASES.EXECUTING);
  expect(phaseForControlDecision({ action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL })).toBe(PHASES.PLAN_APPROVAL_PENDING);
  expect(phaseForControlDecision({ action: CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL })).toBe(PHASES.DIFF_APPROVAL_PENDING);
  expect(phaseForControlDecision({ action: CONTROL_ACTIONS.STOP })).toBe(PHASES.STOPPED_SECURITY);
  expect(phaseForControlDecision({ action: CONTROL_ACTIONS.ESCALATE })).toBe(PHASES.ESCALATED);
});

test('explainApprovalPending distinguishes plan and diff approval conditions', () => {
  expect(explainApprovalPending({ action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL, reason: CONTROL_REASONS.PRODUCTION_RISK_REQUIRES_PLAN_APPROVAL, approval_type: APPROVAL_TYPES.PLAN })).toMatchObject({
    phase: PHASES.PLAN_APPROVAL_PENDING,
    known_reason: true,
    requires_plan_approval: true,
    requires_diff_approval: false
  });
  expect(explainApprovalPending({ action: CONTROL_ACTIONS.REQUIRE_DIFF_APPROVAL, reason: CONTROL_REASONS.DIFF_APPROVAL_REQUIRED, approval_type: APPROVAL_TYPES.DIFF })).toMatchObject({
    phase: PHASES.DIFF_APPROVAL_PENDING,
    known_reason: true,
    requires_plan_approval: false,
    requires_diff_approval: true
  });
});

test('transitionForControlDecision persists control decision and security stop', () => {
  const rootDir = tmpRoot();
  const decision = {
    action: CONTROL_ACTIONS.REQUIRE_PLAN_APPROVAL,
    reason: CONTROL_REASONS.APPROVAL_MODE_RISK_THRESHOLD,
    approval_type: APPROVAL_TYPES.PLAN,
    risk_score: 3
  };
  const pending = transitionForControlDecision(decision, { rootDir, current_approval_id: 'APR-1' });
  expect(pending).toMatchObject({ phase: PHASES.PLAN_APPROVAL_PENDING, current_approval_id: 'APR-1', control_decision: decision, security_stop: false });

  saveState({ phase: PHASES.RISK_ASSESSMENT, current_approval_id: null, security_stop: false }, rootDir);
  const stopped = transitionForControlDecision({ action: CONTROL_ACTIONS.STOP, reason: CONTROL_REASONS.RISK_5_SECURITY_STOP }, { rootDir });
  expect(stopped).toMatchObject({ phase: PHASES.STOPPED_SECURITY, security_stop: true, blocked_reason: CONTROL_REASONS.RISK_5_SECURITY_STOP });
  expect(loadState(rootDir).phase).toBe(PHASES.STOPPED_SECURITY);
});
