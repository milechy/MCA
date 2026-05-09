const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory, updateStory, STORY_STATUSES } = require('../../src/ralph/story-queue');
const { LOOP_PHASES, defaultApprovalId, defaultJobId, defaultSandboxRoot, phaseForUltraPlan, statusForPhase, nextActionForPhase, tickAutonomousLoop, pauseStory } = require('../../src/ralph/autonomous-loop');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autonomous-loop-'));
}

function seedStory(rootDir, overrides = {}) {
  const created = createStory({
    story_id: 'STORY-LOOP',
    requirement: 'Add a focused Ralph autonomous loop test.',
    mode: 'fullauto',
    target_env: 'local',
    requested_paths: ['tests/ralph/autonomous-loop.spec.js'],
    ...overrides
  }, { rootDir, now: new Date('2026-05-08T13:00:00.000Z') });
  expect(created.ok).toBe(true);
  return created.story;
}

test('phase helpers map control decisions to bounded next steps', () => {
  expect(defaultApprovalId({ story_id: 'STORY-LOOP' })).toBe('APR-OPENCODE-AUTO-LOOP');
  expect(defaultJobId({ story_id: 'STORY-LOOP' })).toBe('JOB-OPENCODE-AUTO-LOOP');
  expect(defaultSandboxRoot({ story_id: 'STORY-LOOP' })).toBe('.ralph/tmp/opencode-sandbox/APR-OPENCODE-AUTO-LOOP');
  expect(phaseForUltraPlan({ control_decision: { action: 'auto_execute' } })).toBe(LOOP_PHASES.OPENCODE_RUNNING);
  expect(phaseForUltraPlan({ control_decision: { action: 'require_plan_approval' } })).toBe(LOOP_PHASES.PLAN_APPROVAL_PENDING);
  expect(phaseForUltraPlan({ control_decision: { action: 'require_diff_approval' } })).toBe(LOOP_PHASES.DIFF_APPROVAL_PENDING);
  expect(phaseForUltraPlan({ control_decision: { action: 'stop' } })).toBe(LOOP_PHASES.ESCALATED);
  expect(statusForPhase(LOOP_PHASES.OPENCODE_RUNNING)).toBe(STORY_STATUSES.RUNNING);
  expect(statusForPhase(LOOP_PHASES.PLAN_APPROVAL_PENDING)).toBe(STORY_STATUSES.WAITING_APPROVAL);
  expect(statusForPhase(LOOP_PHASES.DONE)).toBe(STORY_STATUSES.COMPLETED);
  expect(nextActionForPhase(LOOP_PHASES.OPENCODE_RUNNING)).toBe('dispatch_opencode_candidate_patch');
});

test('tickAutonomousLoop advances queued story through UltraPlan into OpenCode-ready phase without execution', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir);

  const result = tickAutonomousLoop({ rootDir, story_id: 'STORY-LOOP', now: new Date('2026-05-08T13:01:00.000Z') });

  expect(result).toMatchObject({
    ok: true,
    stage: 'autonomous_loop_tick',
    reason: null,
    story_id: 'STORY-LOOP',
    from_phase: 'PLAN',
    to_phase: 'OPENCODE_RUNNING',
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: 'dispatch_opencode_candidate_patch'
  });
  expect(result.ultraplan.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(readStory(rootDir, 'STORY-LOOP')).toMatchObject({
    status: 'running',
    current_phase: 'OPENCODE_RUNNING',
    current_plan_hash: result.ultraplan.plan_hash
  });
});

test('tickAutonomousLoop stops at plan approval boundary', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { mode: 'approval', target_env: 'staging', requested_paths: ['supabase/migrations/001_add_table.sql'] });

  const result = tickAutonomousLoop({ rootDir, story_id: 'STORY-LOOP', now: new Date('2026-05-08T13:01:00.000Z') });

  expect(result.ok).toBe(true);
  expect(result.to_phase).toBe(LOOP_PHASES.PLAN_APPROVAL_PENDING);
  expect(result.story.status).toBe(STORY_STATUSES.WAITING_APPROVAL);
  expect(result.next_action).toBe('request_plan_approval_then_resume');
  expect(readStory(rootDir, 'STORY-LOOP')).toMatchObject({ status: 'waiting_approval', current_phase: 'PLAN_APPROVAL_PENDING' });
});

test('tickAutonomousLoop waits at approval boundary until approval map says approved', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { status: 'waiting_approval', current_phase: LOOP_PHASES.PLAN_APPROVAL_PENDING, current_approval_id: 'APR-LOOP' });

  const waiting = tickAutonomousLoop({ rootDir, story_id: 'STORY-LOOP' });
  expect(waiting).toMatchObject({ ok: true, reason: 'waiting_for_approval', to_phase: LOOP_PHASES.PLAN_APPROVAL_PENDING, approval_id: 'APR-LOOP', next_action: 'approve_or_modify_story_before_resume' });

  const resumed = tickAutonomousLoop({ rootDir, story_id: 'STORY-LOOP', approvals: { 'APR-LOOP': 'approved' }, now: new Date('2026-05-08T13:02:00.000Z') });
  expect(resumed).toMatchObject({ ok: true, reason: null, from_phase: LOOP_PHASES.PLAN_APPROVAL_PENDING, to_phase: LOOP_PHASES.OPENCODE_RUNNING, approval_id: 'APR-LOOP', next_action: 'dispatch_opencode_candidate_patch' });
  expect(readStory(rootDir, 'STORY-LOOP')).toMatchObject({ status: 'running', current_phase: 'OPENCODE_RUNNING' });
});

test('tickAutonomousLoop dispatches OpenCode candidate.patch job from OPENCODE_RUNNING phase', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { status: 'running', current_phase: LOOP_PHASES.OPENCODE_RUNNING, current_plan_hash: 'sha256:abc', last_ultraplan: { tasks: [{ agent: 'opencode', objective: 'Implement loop test' }] } });
  const calls = [];
  const dispatcher = (input) => {
    calls.push(input);
    return {
      ok: true,
      reason: null,
      job_id: input.job_id,
      approval_id: input.approval_id,
      sandbox_root: input.sandbox_root,
      candidate_patch_path: `${input.sandbox_root}/candidate.patch`,
      execution_connected: true,
      commands_executed: ['opencode run bounded task'],
      files_modified: [`${input.sandbox_root}/candidate.patch`],
      repository_files_modified: [],
      patch_preview: { ok: true, requires_approval: true }
    };
  };

  const result = tickAutonomousLoop({ rootDir, story_id: 'STORY-LOOP', now: new Date('2026-05-08T13:03:00.000Z'), opencode_dispatcher: dispatcher });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    from_phase: LOOP_PHASES.OPENCODE_RUNNING,
    to_phase: LOOP_PHASES.PATCH_PREVIEW,
    approval_id: 'APR-OPENCODE-AUTO-LOOP',
    job_id: 'JOB-OPENCODE-AUTO-LOOP',
    candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-OPENCODE-AUTO-LOOP/candidate.patch',
    execution_connected: true,
    commands_executed: ['opencode run bounded task'],
    files_modified: ['.ralph/tmp/opencode-sandbox/APR-OPENCODE-AUTO-LOOP/candidate.patch'],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: 'preview_candidate_patch_and_decide_apply'
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ task: 'Implement loop test', requested_paths: ['tests/ralph/autonomous-loop.spec.js'] });
  expect(readStory(rootDir, 'STORY-LOOP')).toMatchObject({
    status: 'running',
    current_phase: 'PATCH_PREVIEW',
    current_approval_id: 'APR-OPENCODE-AUTO-LOOP',
    current_job_id: 'JOB-OPENCODE-AUTO-LOOP',
    current_candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-OPENCODE-AUTO-LOOP/candidate.patch'
  });
});

test('tickAutonomousLoop keeps OPENCODE_RUNNING when OpenCode dispatch fails', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { status: 'running', current_phase: LOOP_PHASES.OPENCODE_RUNNING });
  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-LOOP',
    opencode_dispatcher: (input) => ({ ok: false, reason: 'preflight_failed', job_id: input.job_id, approval_id: input.approval_id, sandbox_root: input.sandbox_root, execution_connected: false, commands_executed: [], files_modified: [] })
  });
  expect(result).toMatchObject({ ok: false, reason: 'preflight_failed', from_phase: LOOP_PHASES.OPENCODE_RUNNING, to_phase: LOOP_PHASES.OPENCODE_RUNNING, next_action: 'fix_opencode_dispatch_failure' });
  expect(readStory(rootDir, 'STORY-LOOP')).toMatchObject({ status: 'running', current_phase: 'OPENCODE_RUNNING', blocked_reason: 'preflight_failed' });
});

test('tickAutonomousLoop handles missing and terminal stories safely', () => {
  const rootDir = tmpRoot();
  expect(tickAutonomousLoop({ rootDir })).toMatchObject({ ok: false, reason: 'story_id_required' });
  expect(tickAutonomousLoop({ rootDir, story_id: 'STORY-NOPE' })).toMatchObject({ ok: false, reason: 'story_not_found' });
  seedStory(rootDir, { status: 'completed', current_phase: LOOP_PHASES.DONE });
  expect(tickAutonomousLoop({ rootDir, story_id: 'STORY-LOOP' })).toMatchObject({ ok: true, reason: 'story_terminal', to_phase: LOOP_PHASES.DONE, next_action: 'story_complete' });
});

test('pauseStory stops a story without execution side effects', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { status: 'running', current_phase: LOOP_PHASES.OPENCODE_RUNNING });

  const result = pauseStory('STORY-LOOP', { rootDir, now: new Date('2026-05-08T13:05:00.000Z'), reason: 'operator_pause' });
  expect(result).toMatchObject({
    ok: true,
    story_id: 'STORY-LOOP',
    to_phase: LOOP_PHASES.STOPPED,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: 'story_stopped'
  });
  expect(readStory(rootDir, 'STORY-LOOP')).toMatchObject({ status: 'stopped', current_phase: 'STOPPED', blocked_reason: 'operator_pause' });
});
