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
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.GATES, attempts: 0, max_attempts: 3 });
  const update = updateStory('STORY-GATES', { last_ultraplan: { tasks: [{ agent: 'opencode', objective: 'Implement original task' }] } }, { rootDir, now: new Date('2026-05-08T15:03:30.000Z'), event: 'seed_ultraplan_fixture' });
  expect(update.ok).toBe(true);
  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-GATES',
    gate_runner: () => ({ ok: false, stage: 'opencode_gates', reason: 'opencode_gates_failed', command: 'scripts/gates/run-all.sh', exit_code: 1, stdout_preview: 'failing test output', stderr_preview: 'stderr output', execution_connected: true, commands_executed: ['scripts/gates/run-all.sh'], files_modified: [], repository_files_modified: [] }),
    now: new Date('2026-05-08T15:04:00.000Z')
  });
  expect(result).toMatchObject({ ok: false, reason: 'opencode_gates_failed', from_phase: LOOP_PHASES.GATES, to_phase: LOOP_PHASES.FIX_LOOP, next_action: 'dispatch_opencode_fix_candidate_patch_via_nemoclaw' });
  const story = readStory(rootDir, 'STORY-GATES');
  expect(story).toMatchObject({ status: 'running', current_phase: 'FIX_LOOP', attempts: 1, blocked_reason: 'opencode_gates_failed' });
  expect(story.last_gate_failure_summary).toMatchObject({ reason: 'opencode_gates_failed', stdout_preview: 'failing test output' });
});

test('FIX_LOOP returns to OPENCODE_RUNNING with failure context in task', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.FIX_LOOP });
  const update = updateStory('STORY-GATES', {
    last_gate_failure_summary: { reason: 'opencode_gates_failed', stdout_preview: 'failing test output' },
    last_ultraplan: { tasks: [{ agent: 'opencode', objective: 'Implement original task' }] }
  }, { rootDir, now: new Date('2026-05-08T15:04:30.000Z'), event: 'seed_fix_loop_fixture' });
  expect(update.ok).toBe(true);
  expect(taskForStory(readStory(rootDir, 'STORY-GATES'))).toContain('Fix bounded gate failure');
  const result = tickAutonomousLoop({ rootDir, story_id: 'STORY-GATES', now: new Date('2026-05-08T15:05:00.000Z') });
  expect(result).toMatchObject({ ok: true, reason: null, from_phase: LOOP_PHASES.FIX_LOOP, to_phase: LOOP_PHASES.OPENCODE_RUNNING, next_action: 'dispatch_opencode_candidate_patch_via_nemoclaw' });
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

// ============================================================
// Phase 5 #7: rollback must run on BOTH ESCALATED and FIX_LOOP paths.
//
// Bug: the original Phase 1 #7 rollback was gated on
// `if (repair.escalation_required)`, so a gate failure that routed to
// FIX_LOOP (the common case — under max_attempts) left the partial apply
// in the working tree. The next Kimi dispatch then produced a patch with
// `new file mode 100644` for the just-applied path, and the dispatcher's
// validateCandidatePatchAgainstRepository rejected every retry with
// candidate_patch_existing_file_marked_new — burning all attempts before
// any real repair could happen. Caught live in Phase 5 #7 E2E smoke.
// ============================================================

test('Phase 5 #7: GATES failure routing to FIX_LOOP rolls back the partial apply (NOT only on escalation)', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.GATES, attempts: 0, max_attempts: 3 });
  // Simulate a previous APPLY having created the file in the trunk worktree —
  // this is exactly the state the smoke walked into.
  const targetPath = path.join(rootDir, 'tests', 'ralph', 'autonomous-loop-gates.spec.js');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, '// partial apply output that should be rolled back\n');
  // Stash an apply_result so the rollback knows which file to undo.
  updateStory('STORY-GATES', {
    last_apply_result: {
      ok: true,
      repository_files_modified: ['tests/ralph/autonomous-loop-gates.spec.js']
    },
    last_ultraplan: { tasks: [{ agent: 'opencode', objective: 'Implement original task' }] }
  }, { rootDir, now: new Date('2026-05-08T15:03:30.000Z'), event: 'seed_apply_result_fixture' });

  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-GATES',
    gate_runner: () => ({
      ok: false,
      stage: 'opencode_gates',
      reason: 'opencode_gates_failed',
      command: 'scripts/gates/run-all.sh',
      exit_code: 1,
      stdout_preview: 'failing test output',
      stderr_preview: 'stderr output',
      execution_connected: true,
      commands_executed: ['scripts/gates/run-all.sh'],
      files_modified: ['tests/ralph/autonomous-loop-gates.spec.js'],
      repository_files_modified: ['tests/ralph/autonomous-loop-gates.spec.js']
    }),
    now: new Date('2026-05-08T15:04:00.000Z')
  });
  expect(result.to_phase).toBe(LOOP_PHASES.FIX_LOOP);
  // The rollback MUST run on the FIX_LOOP path now, not just on ESCALATED.
  // (apply_rollback.ok depends on git state of the tmpRoot, which isn't a
  // real repo here — the unlink itself is what matters.)
  expect(result.apply_rollback).toBeTruthy();
  expect(result.apply_rollback.paths).toContain('tests/ralph/autonomous-loop-gates.spec.js');
  // The persisted story should record the rollback for downstream observability.
  const story = readStory(rootDir, 'STORY-GATES');
  expect(story.last_apply_rollback).toBeTruthy();
  // And the file the apply created must no longer be in the working tree —
  // the dispatcher's pathExistsInRepo validator would otherwise reject the
  // next Kimi candidate's `new file mode 100644` line for this path.
  expect(fs.existsSync(targetPath)).toBe(false);
});

test('Phase 5 #7: GATES failure routing to ESCALATED still rolls back the partial apply (regression guard)', () => {
  // Phase 1 #7 already covered this case; Phase 5 #7 extension must NOT
  // regress it. attempts=2/max=3 means the next failure escalates.
  const rootDir = tmpRoot();
  seed(rootDir, { status: 'running', current_phase: LOOP_PHASES.GATES, attempts: 2, max_attempts: 3 });
  const targetPath = path.join(rootDir, 'tests', 'ralph', 'autonomous-loop-gates.spec.js');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, '// partial apply output that should be rolled back\n');
  updateStory('STORY-GATES', {
    last_apply_result: { ok: true, repository_files_modified: ['tests/ralph/autonomous-loop-gates.spec.js'] }
  }, { rootDir, now: new Date('2026-05-08T15:05:00.000Z'), event: 'seed_apply_result_fixture' });

  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-GATES',
    gate_runner: () => ({
      ok: false,
      stage: 'opencode_gates',
      reason: 'opencode_gates_failed',
      exit_code: 1,
      execution_connected: true,
      commands_executed: ['scripts/gates/run-all.sh'],
      files_modified: ['tests/ralph/autonomous-loop-gates.spec.js'],
      repository_files_modified: ['tests/ralph/autonomous-loop-gates.spec.js']
    }),
    now: new Date('2026-05-08T15:06:00.000Z')
  });
  expect(result.to_phase).toBe(LOOP_PHASES.ESCALATED);
  expect(result.apply_rollback).toBeTruthy();
  expect(result.apply_rollback.paths).toContain('tests/ralph/autonomous-loop-gates.spec.js');
  expect(fs.existsSync(targetPath)).toBe(false);
});
