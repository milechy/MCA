const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PHASES } = require('../../src/ralph/types');
const { ESCALATION_REASONS, buildFailureEscalation, recordFailureEscalation } = require('../../src/ralph/failure-escalation');

function tmpRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-escalation-'));
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  return rootDir;
}

test('buildFailureEscalation maps security reasons to STOPPED_SECURITY', () => {
  const escalation = buildFailureEscalation({
    reason: ESCALATION_REASONS.RISK_5,
    story_id: 'STORY-1',
    approval_id: 'APR-1',
    agent_id: 'agent-1',
    diff_hash: 'sha256:abc',
    evidence: { secret: 'redacted' }
  });

  expect(escalation).toMatchObject({
    ok: true,
    stage: 'failure_escalation',
    reason: ESCALATION_REASONS.RISK_5,
    target_phase: PHASES.STOPPED_SECURITY,
    story_id: 'STORY-1',
    approval_id: 'APR-1',
    agent_id: 'agent-1',
    diff_hash: 'sha256:abc',
    deploy_allowed: false,
    migration_allowed: false,
    merge_allowed: false,
    push_allowed: false,
    unrestricted_shell_allowed: false,
    next_action: 'security_stop_until_human_resume_approval'
  });
  expect(escalation.actions).toEqual({
    stop_current_story: true,
    stop_agent_process: true,
    stop_secret_injection: true,
    preserve_git_diff: true,
    preserve_audit_log: true,
    notify_telegram: true,
    notify_dashboard: true,
    require_human_to_resume: true
  });
});

test('buildFailureEscalation maps gate failure to ESCALATED', () => {
  expect(buildFailureEscalation({ reason: ESCALATION_REASONS.GATE_FAILURE })).toMatchObject({
    reason: ESCALATION_REASONS.GATE_FAILURE,
    target_phase: PHASES.ESCALATED,
    next_action: 'human_review_required_before_resume'
  });
});

test('recordFailureEscalation writes bounded audit event', () => {
  const rootDir = tmpRoot();
  const escalation = buildFailureEscalation({ reason: ESCALATION_REASONS.SECRET_POLICY, story_id: 'STORY-2' });
  const event = recordFailureEscalation(escalation, { rootDir });
  expect(event).toMatchObject({ event: 'failure_escalation', reason: ESCALATION_REASONS.SECRET_POLICY, target_phase: PHASES.STOPPED_SECURITY, story_id: 'STORY-2' });
  const log = fs.readFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), 'utf8');
  expect(log).toContain('failure_escalation');
});
