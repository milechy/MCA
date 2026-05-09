const { STORY_STATUSES, readStory, updateStory, summarizeStory } = require('./story-queue');
const { runUltraPlan } = require('./ultraplan-runner');
const { runOpenCodeCandidatePatch } = require('../telegram/opencode-run');
const { opencodeSandboxRunnerPreflight, OPENCODE_SANDBOX_ENV } = require('../telegram/opencode-sandbox-preflight');

const AUTONOMOUS_LOOP_VERSION = 'autonomous_loop_v0_1';
const LOOP_PHASES = Object.freeze({
  PLAN: 'PLAN',
  PLAN_APPROVAL_PENDING: 'PLAN_APPROVAL_PENDING',
  OPENCODE_RUNNING: 'OPENCODE_RUNNING',
  PATCH_PREVIEW: 'PATCH_PREVIEW',
  DIFF_APPROVAL_PENDING: 'DIFF_APPROVAL_PENDING',
  APPLY: 'APPLY',
  GATES: 'GATES',
  FIX_LOOP: 'FIX_LOOP',
  COMMIT_APPROVAL_PENDING: 'COMMIT_APPROVAL_PENDING',
  PUSH_APPROVAL_PENDING: 'PUSH_APPROVAL_PENDING',
  PR_APPROVAL_PENDING: 'PR_APPROVAL_PENDING',
  DONE: 'DONE',
  STOPPED: 'STOPPED',
  ESCALATED: 'ESCALATED'
});

function baseResult(overrides = {}) {
  return {
    ok: false,
    stage: 'autonomous_loop_tick',
    reason: null,
    version: AUTONOMOUS_LOOP_VERSION,
    story_id: null,
    from_phase: null,
    to_phase: null,
    story: null,
    ultraplan: null,
    opencode: null,
    approval_id: null,
    job_id: null,
    candidate_patch_path: null,
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
    next_action: 'inspect_autonomous_loop_failure',
    ...overrides
  };
}

function defaultApprovalId(story) {
  return `APR-OPENCODE-AUTO-${story.story_id.replace(/^STORY-/, '')}`;
}

function defaultJobId(story) {
  return `JOB-OPENCODE-AUTO-${story.story_id.replace(/^STORY-/, '')}`;
}

function defaultSandboxRoot(story) {
  return `.ralph/tmp/opencode-sandbox/${defaultApprovalId(story)}`;
}

function taskForStory(story) {
  const plan = story.last_ultraplan || {};
  const task = Array.isArray(plan.tasks) ? plan.tasks.find((item) => item.agent === 'opencode') : null;
  return task?.objective || story.requirement;
}

function phaseForUltraPlan(ultraplan) {
  const action = ultraplan?.control_decision?.action;
  if (action === 'stop' || action === 'escalate') return LOOP_PHASES.ESCALATED;
  if (action === 'require_plan_approval') return LOOP_PHASES.PLAN_APPROVAL_PENDING;
  if (action === 'require_diff_approval') return LOOP_PHASES.DIFF_APPROVAL_PENDING;
  return LOOP_PHASES.OPENCODE_RUNNING;
}

function statusForPhase(phase) {
  if ([LOOP_PHASES.PLAN_APPROVAL_PENDING, LOOP_PHASES.DIFF_APPROVAL_PENDING, LOOP_PHASES.COMMIT_APPROVAL_PENDING, LOOP_PHASES.PUSH_APPROVAL_PENDING, LOOP_PHASES.PR_APPROVAL_PENDING].includes(phase)) return STORY_STATUSES.WAITING_APPROVAL;
  if ([LOOP_PHASES.DONE].includes(phase)) return STORY_STATUSES.COMPLETED;
  if ([LOOP_PHASES.STOPPED].includes(phase)) return STORY_STATUSES.STOPPED;
  if ([LOOP_PHASES.ESCALATED].includes(phase)) return STORY_STATUSES.FAILED;
  return STORY_STATUSES.RUNNING;
}

function nextActionForPhase(phase) {
  switch (phase) {
    case LOOP_PHASES.PLAN_APPROVAL_PENDING:
      return 'request_plan_approval_then_resume';
    case LOOP_PHASES.DIFF_APPROVAL_PENDING:
      return 'request_diff_approval_then_resume';
    case LOOP_PHASES.OPENCODE_RUNNING:
      return 'dispatch_opencode_candidate_patch';
    case LOOP_PHASES.PATCH_PREVIEW:
      return 'preview_candidate_patch_and_decide_apply';
    case LOOP_PHASES.APPLY:
      return 'apply_approved_candidate_patch';
    case LOOP_PHASES.GATES:
      return 'run_gates_for_applied_patch';
    case LOOP_PHASES.FIX_LOOP:
      return 'dispatch_opencode_fix_candidate_patch';
    case LOOP_PHASES.COMMIT_APPROVAL_PENDING:
      return 'request_commit_approval_then_resume';
    case LOOP_PHASES.PUSH_APPROVAL_PENDING:
      return 'request_push_approval_then_resume';
    case LOOP_PHASES.PR_APPROVAL_PENDING:
      return 'request_pr_approval_then_resume';
    case LOOP_PHASES.DONE:
      return 'story_complete';
    case LOOP_PHASES.ESCALATED:
      return 'human_escalation_required';
    case LOOP_PHASES.STOPPED:
      return 'story_stopped';
    default:
      return 'advance_autonomous_loop';
  }
}

function updateStoryForPhase(story, phase, patch, options) {
  return updateStory(story.story_id, {
    status: statusForPhase(phase),
    current_phase: phase,
    ...patch
  }, options);
}

function advancePlanPhase(story, { rootDir, now }) {
  const ultraplan = runUltraPlan(story);
  if (!ultraplan.ok) {
    const failed = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, { blocked_reason: ultraplan.reason }, { rootDir, now, event: 'ultraplan_failed' });
    return baseResult({ ok: false, reason: ultraplan.reason, story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.ESCALATED, story: failed.summary || summarizeStory(failed.story || story), ultraplan, next_action: 'human_escalation_required' });
  }
  const nextPhase = phaseForUltraPlan(ultraplan);
  const blockedReason = nextPhase === LOOP_PHASES.ESCALATED ? ultraplan.control_decision?.reason || 'control_decision_escalated' : null;
  const updated = updateStoryForPhase(story, nextPhase, {
    current_plan_hash: ultraplan.plan_hash,
    blocked_reason: blockedReason,
    last_ultraplan: ultraplan.plan,
    requested_paths: ultraplan.requested_paths
  }, { rootDir, now, event: 'ultraplan_created' });
  return baseResult({
    ok: nextPhase !== LOOP_PHASES.ESCALATED,
    reason: blockedReason,
    story_id: story.story_id,
    from_phase: story.current_phase,
    to_phase: nextPhase,
    story: updated.summary,
    ultraplan,
    next_action: nextActionForPhase(nextPhase)
  });
}

function advanceWaitingApprovalPhase(story, { rootDir, now, approvals = {} }) {
  const approvalId = story.current_approval_id;
  const approved = approvalId && approvals[approvalId] === 'approved';
  if (!approved) {
    return baseResult({
      ok: true,
      reason: 'waiting_for_approval',
      story_id: story.story_id,
      from_phase: story.current_phase,
      to_phase: story.current_phase,
      story: summarizeStory(story),
      approval_id: approvalId || null,
      next_action: 'approve_or_modify_story_before_resume'
    });
  }
  const nextPhase = story.current_phase === LOOP_PHASES.PLAN_APPROVAL_PENDING ? LOOP_PHASES.OPENCODE_RUNNING : LOOP_PHASES.APPLY;
  const updated = updateStoryForPhase(story, nextPhase, { blocked_reason: null }, { rootDir, now, event: 'approval_resumed' });
  return baseResult({
    ok: true,
    story_id: story.story_id,
    from_phase: story.current_phase,
    to_phase: nextPhase,
    story: updated.summary,
    approval_id: approvalId,
    next_action: nextActionForPhase(nextPhase)
  });
}

function buildOpenCodePreflight(story, { rootDir, now, env, pre_secret_scan_ok }) {
  const approvalId = story.current_approval_id || defaultApprovalId(story);
  const sandboxRoot = story.current_sandbox_root || defaultSandboxRoot(story);
  const runEnv = { ...env, [OPENCODE_SANDBOX_ENV]: env?.[OPENCODE_SANDBOX_ENV] || 'true' };
  return opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: approvalId,
    sandbox_root: sandboxRoot,
    requested_paths: story.requested_paths || [],
    pre_secret_scan_ok: pre_secret_scan_ok === true,
    env: runEnv,
    now
  });
}

function advanceOpenCodeRunningPhase(story, { rootDir, now, env = process.env, pre_secret_scan_ok = false, opencode_dispatcher, opencode_command, opencode_args, timeout_ms }) {
  const approvalId = story.current_approval_id || defaultApprovalId(story);
  const jobId = story.current_job_id || defaultJobId(story);
  const sandboxRoot = story.current_sandbox_root || defaultSandboxRoot(story);
  const task = taskForStory(story);
  const dispatcher = opencode_dispatcher || ((input) => {
    const preflight = buildOpenCodePreflight(story, { rootDir, now, env, pre_secret_scan_ok });
    if (!preflight.ok) return { ...preflight, job_id: jobId, approval_id: approvalId, sandbox_root: sandboxRoot, task_preview: task, candidate_patch_path: null, patch_preview: null };
    return runOpenCodeCandidatePatch(preflight, { rootDir, task, command: opencode_command, args: opencode_args, env: { ...env, [OPENCODE_SANDBOX_ENV]: 'true' }, timeout_ms, now: () => now });
  });
  const opencode = dispatcher({ rootDir, story, approval_id: approvalId, job_id: jobId, sandbox_root: sandboxRoot, task, requested_paths: story.requested_paths || [], now });
  const ok = opencode.ok === true;
  const nextPhase = ok ? LOOP_PHASES.PATCH_PREVIEW : LOOP_PHASES.OPENCODE_RUNNING;
  const updated = updateStoryForPhase(story, nextPhase, {
    current_approval_id: approvalId,
    current_job_id: opencode.job_id || jobId,
    current_sandbox_root: sandboxRoot,
    current_candidate_patch_path: opencode.candidate_patch_path || null,
    blocked_reason: ok ? null : opencode.reason || 'opencode_dispatch_failed'
  }, { rootDir, now, event: ok ? 'opencode_candidate_patch_created' : 'opencode_dispatch_failed' });

  return baseResult({
    ok,
    reason: ok ? null : opencode.reason || 'opencode_dispatch_failed',
    story_id: story.story_id,
    from_phase: story.current_phase,
    to_phase: nextPhase,
    story: updated.summary,
    opencode,
    approval_id: approvalId,
    job_id: opencode.job_id || jobId,
    candidate_patch_path: opencode.candidate_patch_path || null,
    execution_connected: opencode.execution_connected === true,
    commands_executed: opencode.commands_executed || [],
    files_modified: opencode.files_modified || [],
    repository_files_modified: [],
    next_action: ok ? nextActionForPhase(LOOP_PHASES.PATCH_PREVIEW) : 'fix_opencode_dispatch_failure'
  });
}

function advanceTerminalPhase(story) {
  return baseResult({
    ok: true,
    reason: 'story_terminal',
    story_id: story.story_id,
    from_phase: story.current_phase,
    to_phase: story.current_phase,
    story: summarizeStory(story),
    next_action: nextActionForPhase(story.current_phase)
  });
}

function tickAutonomousLoop({ rootDir = process.cwd(), story_id, now = new Date(), approvals = {}, env = process.env, pre_secret_scan_ok = false, opencode_dispatcher, opencode_command, opencode_args, timeout_ms } = {}) {
  if (!story_id) return baseResult({ reason: 'story_id_required' });
  const story = readStory(rootDir, story_id);
  if (!story) return baseResult({ reason: 'story_not_found', story_id });
  if (story.status === STORY_STATUSES.STOPPED || story.current_phase === LOOP_PHASES.STOPPED) return advanceTerminalPhase(story);
  if (story.status === STORY_STATUSES.COMPLETED || story.current_phase === LOOP_PHASES.DONE) return advanceTerminalPhase(story);
  if (story.status === STORY_STATUSES.FAILED || story.current_phase === LOOP_PHASES.ESCALATED) return advanceTerminalPhase(story);

  switch (story.current_phase || LOOP_PHASES.PLAN) {
    case LOOP_PHASES.PLAN:
      return advancePlanPhase(story, { rootDir, now });
    case LOOP_PHASES.PLAN_APPROVAL_PENDING:
    case LOOP_PHASES.DIFF_APPROVAL_PENDING:
    case LOOP_PHASES.COMMIT_APPROVAL_PENDING:
    case LOOP_PHASES.PUSH_APPROVAL_PENDING:
    case LOOP_PHASES.PR_APPROVAL_PENDING:
      return advanceWaitingApprovalPhase(story, { rootDir, now, approvals });
    case LOOP_PHASES.OPENCODE_RUNNING:
      return advanceOpenCodeRunningPhase(story, { rootDir, now, env, pre_secret_scan_ok, opencode_dispatcher, opencode_command, opencode_args, timeout_ms });
    default:
      return baseResult({ ok: false, reason: 'loop_phase_not_supported_yet', story_id: story.story_id, from_phase: story.current_phase, to_phase: story.current_phase, story: summarizeStory(story), next_action: 'implement_next_autonomous_loop_phase' });
  }
}

function pauseStory(story_id, { rootDir = process.cwd(), now = new Date(), reason = 'operator_pause' } = {}) {
  const updated = updateStory(story_id, { status: STORY_STATUSES.STOPPED, current_phase: LOOP_PHASES.STOPPED, blocked_reason: reason }, { rootDir, now, event: 'story_paused' });
  if (!updated.ok) return baseResult({ reason: updated.reason, story_id });
  return baseResult({ ok: true, story_id, from_phase: null, to_phase: LOOP_PHASES.STOPPED, story: updated.summary, reason: null, next_action: 'story_stopped' });
}

module.exports = {
  AUTONOMOUS_LOOP_VERSION,
  LOOP_PHASES,
  defaultApprovalId,
  defaultJobId,
  defaultSandboxRoot,
  taskForStory,
  phaseForUltraPlan,
  statusForPhase,
  nextActionForPhase,
  buildOpenCodePreflight,
  tickAutonomousLoop,
  pauseStory
};
