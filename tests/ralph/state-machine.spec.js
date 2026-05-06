const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PHASES } = require('../../src/ralph/types');
const {
  canTransition,
  loadState,
  saveState,
  transitionState,
  triggerSecurityStop,
  phaseForControlDecision
} = require('../../src/ralph/state-machine');

function makeTempRoot(initialPhase = PHASES.IDLE) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-state-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, '.ralph', 'state.json'),
    `${JSON.stringify({
      loop_id: 'test',
      phase: initialPhase,
      current_story_id: null,
      iteration: 0,
      consecutive_failures: 0,
      active_mode: 'approval',
      current_approval_id: null,
      last_green_commit: null,
      security_stop: false,
      updated_at: '2026-05-06T00:00:00+09:00'
    }, null, 2)}\n`,
    'utf8'
  );
  return rootDir;
}

function readAudit(rootDir) {
  const auditPath = path.join(rootDir, '.ralph', 'logs', 'audit.jsonl');
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('allowed state transition updates state and writes audit log', () => {
  const rootDir = makeTempRoot(PHASES.IDLE);

  const next = transitionState(PHASES.PLANNING, {
    rootDir,
    reason: 'start planning'
  });

  expect(next.phase).toBe(PHASES.PLANNING);
  expect(loadState(rootDir).phase).toBe(PHASES.PLANNING);

  const audit = readAudit(rootDir);
  expect(audit).toHaveLength(1);
  expect(audit[0].event).toBe('state_transition');
  expect(audit[0].from).toBe(PHASES.IDLE);
  expect(audit[0].to).toBe(PHASES.PLANNING);
});

test('invalid state transition throws and does not modify state', () => {
  const rootDir = makeTempRoot(PHASES.IDLE);

  expect(() => transitionState(PHASES.COMMITTING, { rootDir })).toThrow('Invalid Ralph transition');
  expect(loadState(rootDir).phase).toBe(PHASES.IDLE);
});

test('security stop sets STOPPED_SECURITY and records blocked reason', () => {
  const rootDir = makeTempRoot(PHASES.RISK_ASSESSMENT);

  const stopped = triggerSecurityStop('risk_5_requires_security_stop', { rootDir });

  expect(stopped.phase).toBe(PHASES.STOPPED_SECURITY);
  expect(stopped.security_stop).toBe(true);
  expect(stopped.blocked_reason).toBe('risk_5_requires_security_stop');

  const audit = readAudit(rootDir);
  expect(audit[0].event).toBe('security_stop');
});

test('STOPPED_SECURITY has no normal outgoing transition', () => {
  expect(canTransition(PHASES.STOPPED_SECURITY, PHASES.IDLE)).toBe(false);
  expect(canTransition(PHASES.STOPPED_SECURITY, PHASES.PLANNING)).toBe(false);
});

test('control decision maps to the expected next phase', () => {
  expect(phaseForControlDecision({ action: 'auto_execute' })).toBe(PHASES.EXECUTING);
  expect(phaseForControlDecision({ action: 'require_plan_approval' })).toBe(PHASES.PLAN_APPROVAL_PENDING);
  expect(phaseForControlDecision({ action: 'require_diff_approval' })).toBe(PHASES.DIFF_APPROVAL_PENDING);
  expect(phaseForControlDecision({ action: 'stop' })).toBe(PHASES.STOPPED_SECURITY);
});
