const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory, updateStory, STORY_STATUSES } = require('../../src/ralph/story-queue');
const { LOOP_PHASES, OPENCODE_RUNTIME_MODES, defaultApprovalId, defaultJobId, defaultSandboxRoot, phaseForUltraPlan, statusForPhase, nextActionForPhase, currentSafeProviderConfig, tickAutonomousLoop, pauseStory } = require('../../src/ralph/autonomous-loop');

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

function fakeSecret() {
  return ['sk', 'provider', 'abcdefghijklmnopqrstuvwxyz'].join('-');
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
  expect(nextActionForPhase(LOOP_PHASES.OPENCODE_RUNNING)).toBe('dispatch_opencode_candidate_patch_via_nemoclaw');
});

test('currentSafeProviderConfig redacts Gemini and Kimi secrets while preserving roles', () => {
  const geminiSecret = fakeSecret();
  const kimiSecret = `${fakeSecret()}-kimi`;
  const config = currentSafeProviderConfig({ RALPH_PLANNING_PROVIDER: 'gemini', GEMINI_API_KEY: geminiSecret, KIMI_API_KEY: kimiSecret });
  expect(config).toMatchObject({
    stage: 'provider_config_safe_summary',
    planning: { provider: 'gemini', role: 'planning', api_key_present: true, api_key_value: '<set:redacted>' },
    execution: { provider: 'kimi', mediated_by: 'nemoclaw', direct_policy_override_allowed: false, apply_allowed: false, commit_allowed: false, push_allowed: false, pr_allowed: false, deploy_allowed: false, migration_allowed: false, secret_access_allowed: false }
  });
  expect(JSON.stringify(config)).not.toContain(geminiSecret);
  expect(JSON.stringify(config)).not.toContain(kimiSecret);
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
    provider_config: {
      planning: { provider: 'deterministic', role: 'planning' },
      execution: { provider: 'kimi', mediated_by: 'nemoclaw', direct_policy_override_allowed: false }
    },
    opencode_runtime_mode: OPENCODE_RUNTIME_MODES.NEMOCLAW,
    mediator: 'nemoclaw',
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
    next_action: 'dispatch_opencode_candidate_patch_via_nemoclaw'
  });
  expect(result.ultraplan.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(readStory(rootDir, 'STORY-LOOP')).toMatchObject({
    status: 'running',
    current_phase: 'OPENCODE_RUNNING',
    current_plan_hash: result.ultraplan.plan_hash,
    planning_provider: 'deterministic',
    execution_provider: 'kimi',
    execution_mediator: 'nemoclaw'
  });
});

test('tickAutonomousLoop stores redacted provider role metadata for Gemini planning mode', () => {
  const rootDir = tmpRoot();
  const geminiSecret = fakeSecret();
  const kimiSecret = `${fakeSecret()}-kimi`;
  seedStory(rootDir);

  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-LOOP',
    now: new Date('2026-05-08T13:01:00.000Z'),
    env: { RALPH_PLANNING_PROVIDER: 'gemini', GEMINI_API_KEY: geminiSecret, KIMI_API_KEY: kimiSecret }
  });

  expect(result).toMatchObject({
    ok: true,
    provider_config: {
      planning: { provider: 'gemini', api_key_present: true, api_key_value: '<set:redacted>' },
      execution: { provider: 'kimi', api_key_present: true, api_key_value: '<set:redacted>', mediated_by: 'nemoclaw' }
    }
  });
  const story = readStory(rootDir, 'STORY-LOOP');
  expect(story).toMatchObject({ planning_provider: 'gemini', execution_provider: 'kimi', execution_mediator: 'nemoclaw' });
  const serialized = JSON.stringify({ result, story });
  expect(serialized).not.toContain(geminiSecret);
  expect(serialized).not.toContain(kimiSecret);
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
  expect(resumed).toMatchObject({ ok: true, reason: null, from_phase: LOOP_PHASES.PLAN_APPROVAL_PENDING, to_phase: LOOP_PHASES.OPENCODE_RUNNING, approval_id: 'APR-LOOP', next_action: 'dispatch_opencode_candidate_patch_via_nemoclaw' });
  expect(readStory(rootDir, 'STORY-LOOP')).toMatchObject({ status: 'running', current_phase: 'OPENCODE_RUNNING' });
});

test('tickAutonomousLoop dispatches OpenCode candidate.patch job from OPENCODE_RUNNING phase', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { status: 'running', current_phase: LOOP_PHASES.OPENCODE_RUNNING, current_plan_hash: 'sha256:abc' });
  const update = updateStory('STORY-LOOP', { last_ultraplan: { tasks: [{ agent: 'opencode', objective: 'Implement loop test' }] } }, { rootDir, now: new Date('2026-05-08T13:02:30.000Z'), event: 'seed_ultraplan_fixture' });
  expect(update.ok).toBe(true);
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
      opencode_runtime_mode: OPENCODE_RUNTIME_MODES.NEMOCLAW,
      mediator: 'nemoclaw',
      execution_connected: true,
      commands_executed: ['nemoclaw opencode run-candidate-patch'],
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
    opencode_runtime_mode: OPENCODE_RUNTIME_MODES.NEMOCLAW,
    mediator: 'nemoclaw',
    execution_connected: true,
    commands_executed: ['nemoclaw opencode run-candidate-patch'],
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
    current_candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-OPENCODE-AUTO-LOOP/candidate.patch',
    current_opencode_runtime_mode: OPENCODE_RUNTIME_MODES.NEMOCLAW,
    current_opencode_mediator: 'nemoclaw'
  });
});

test('tickAutonomousLoop keeps OPENCODE_RUNNING when OpenCode dispatch fails', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { status: 'running', current_phase: LOOP_PHASES.OPENCODE_RUNNING });
  const result = tickAutonomousLoop({
    rootDir,
    story_id: 'STORY-LOOP',
    opencode_dispatcher: (input) => ({ ok: false, reason: 'preflight_failed', job_id: input.job_id, approval_id: input.approval_id, sandbox_root: input.sandbox_root, opencode_runtime_mode: OPENCODE_RUNTIME_MODES.NEMOCLAW, mediator: 'nemoclaw', execution_connected: false, commands_executed: [], files_modified: [] })
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
