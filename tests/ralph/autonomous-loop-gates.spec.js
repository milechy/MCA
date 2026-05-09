const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory, updateStory } = require('../../src/ralph/story-queue');
const { LOOP_PHASES, boundedFailureSummary, taskForStory, tickAutonomousLoop } = require('../../src/ralph/autonomous-loop');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autonomous-loop-gates-'));
}

function seed(rootDir, overrides = {}) {
  const created = createStory({
    story_id: 'STORY-GATES',
    requirement: 'Add autonomous gate loop test.',
    mode: 'fullauto',
    target_env: 'local',
    requested_paths: ['tests/ralph/autonomous-loop-gates.spec.js'],
    ...overrides
  }, { rootDir, now: new Date('2026-05-08T15:00:00.000Z') });
  expect(created.ok).toBe(true);
  return created.story;
}

test('boundedFailureSummary keeps gate output bounded', () => {
  const summary = boundedFailureSummary({
    ok: false,
    stage: 'opencode_gates',
    reason: 'opencode_gates_failed',
    command: 'scripts/gates/run-all.sh',
    exit_code: 1,
    stdout_preview: Array.from({ length: 200 }, (_, index) => `line${index}`).join('\n'),
    stderr_preview: 'err',
    commands_executed: ['scripts/gates/run-all.sh'],
    files_modified: ['tests/a.spec.js'],
    repository_files_modified: ['tests/a.spec.js']
  });
  expect(summary).toMatchObject({
    ok: false,
    stage: 'opencode_gates',
    reason: 'opencode_gates_failed',
    command: 'scripts/gates/run-all.sh',
    exit_code: 1,
    commands_executed: ['scripts/gates/run-all.sh'],
    files_modified: ['tests/a.spec.js'],
    repository_files_modified: ['tests/a.spec.js']
  });
  expect(summary.stdout_preview.length).toBeLessThanOrEqual(600);
});

test('PATCH_PREVIEW advances to DIFF_APPROVAL_PENDING', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.PATCH_PREVIEW, current_approval_id: 'APR-1', current_job_id: 'JOB-1', current_candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-1/candidate.patch' });
  const result = tickAutonomousLoop({ rootDir, story_id: 'STORY-GATES', now: new Date('2026-05-08T15:01:00.000Z') });
  expect(result).toMatchObject({ ok: true, reason: 'diff_approval_required', from_phase: LOOP_PHASES.PATCH_PREVIEW, to_phase: LOOP_PHASES.DIFF_APPROVAL_PENDING, approval_id: 'APR-1', job_id: 'JOB-1', next_action: 'request_diff_approval_then_resume' });
  expect(readStory(rootDir, 'STORY-GATES')).toMatchObject({ status: 'waiting_approval', current_phase: 'DIFF_APPROVAL_PENDING', blocked_reason: 'diff_approval_required' });
});

test('APPLY advances to GATES without applying inside loop', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.APPLY, current_approval_id: 'APR-1' });
  const result = tickAutonomousLoop({ rootDir, story_id: 'STORY-GATES', now: new Date('2026-05-08T15:02:00.000Z') });
  expect(result).toMatchObject({ ok: true, reason: null, from_phase: LOOP_PHASES.APPLY, to_phase: LOOP_PHASES.GATES, execution_connected: false, commands_executed: [], next_action: 'run_gates_for_applied_patch' });
  expect(readStory(rootDir, 'STORY-GATES')).toMatchObject({ status: 'running', current_phase: 'GATES' });
});

test('GATES success advances to commit approval boundary', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.GATES, current_approval_id: 'APR-1', current_patch_hash: 'sha256:patch' });
  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-GATES',
    gate_runner: () => ({ ok: true, stage: 'opencode_gates', reason: null, execution_connected: true, commands_executed: ['scripts/gates/run-all.sh'], files_modified: ['tests/x.spec.js'], repository_files_modified: ['tests/x.spec.js'] }),
    now: new Date('2026-05-08T15:03:00.000Z')
  });
  expect(result).toMatchObject({ ok: true, reason: null, from_phase: LOOP_PHASES.GATES, to_phase: LOOP_PHASES.COMMIT_APPROVAL_PENDING, execution_connected: true, commands_executed: ['scripts/gates/run-all.sh'], next_action: 'request_commit_approval_then_resume' });
  expect(readStory(rootDir, 'STORY-GATES')).toMatchObject({ status: 'waiting_approval', current_phase: 'COMMIT_APPROVAL_PENDING' });
});

test('GATES failure records bounded failure and enters FIX_LOOP', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.GATES, attempts: 0, max_attempts: 3, last_ultraplan: { tasks: [{ agent: 'opencode', objective: 'Implement original task' }] } });
  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-GATES',
    gate_runner: () => ({ ok: false, stage: 'opencode_gates', reason: 'opencode_gates_failed', command: 'scripts/gates/run-all.sh', exit_code: 1, stdout_preview: 'failing test output', stderr_preview: 'stderr output', execution_connected: true, commands_executed: ['scripts/gates/run-all.sh'], files_modified: [], repository_files_modified: [] }),
    now: new Date('2026-05-08T15:04:00.000Z')
  });
  expect(result).toMatchObject({ ok: false, reason: 'opencode_gates_failed', from_phase: LOOP_PHASES.GATES, to_phase: LOOP_PHASES.FIX_LOOP, next_action: 'dispatch_opencode_fix_candidate_patch' });
  const story = readStory(rootDir, 'STORY-GATES');
  expect(story).toMatchObject({ status: 'running', current_phase: 'FIX_LOOP', attempts: 1, blocked_reason: 'opencode_gates_failed' });
  expect(story.last_gate_failure_summary).toMatchObject({ reason: 'opencode_gates_failed', stdout_preview: 'failing test output' });
});

test('FIX_LOOP returns to OPENCODE_RUNNING with failure context in task', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.FIX_LOOP, last_gate_failure_summary: { reason: 'opencode_gates_failed', stdout_preview: 'failing test output' }, last_ultraplan: { tasks: [{ agent: 'opencode', objective: 'Implement original task' }] } });
  expect(taskForStory(readStory(rootDir, 'STORY-GATES'))).toContain('Fix bounded gate failure');
  const result = tickAutonomousLoop({ rootDir, story_id: 'STORY-GATES', now: new Date('2026-05-08T15:05:00.000Z') });
  expect(result).toMatchObject({ ok: true, reason: null, from_phase: LOOP_PHASES.FIX_LOOP, to_phase: LOOP_PHASES.OPENCODE_RUNNING, next_action: 'dispatch_opencode_candidate_patch' });
  expect(readStory(rootDir, 'STORY-GATES')).toMatchObject({ status: 'running', current_phase: 'OPENCODE_RUNNING', current_job_id: null, current_candidate_patch_path: null });
});

test('GATES retry exhaustion escalates safely', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.GATES, attempts: 2, max_attempts: 3 });
  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-GATES',
    gate_runner: () => ({ ok: false, stage: 'opencode_gates', reason: 'opencode_gates_failed', exit_code: 1, execution_connected: true, commands_executed: ['scripts/gates/run-all.sh'], files_modified: [], repository_files_modified: [] }),
    now: new Date('2026-05-08T15:06:00.000Z')
  });
  expect(result).toMatchObject({ ok: false, reason: 'retry_exhausted', from_phase: LOOP_PHASES.GATES, to_phase: LOOP_PHASES.ESCALATED, next_action: 'human_escalation_required' });
  expect(readStory(rootDir, 'STORY-GATES')).toMatchObject({ status: 'failed', current_phase: 'ESCALATED', attempts: 3, blocked_reason: 'opencode_gates_failed' });
});
