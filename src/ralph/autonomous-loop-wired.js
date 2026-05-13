const { readStory, updateStory, summarizeStory, STORY_STATUSES } = require('./story-queue');
const { readApproval } = require('./approval-manager');
const { APPROVAL_STATUSES } = require('./types');
const {
  LOOP_PHASES,
  tickAutonomousLoop,
  defaultSandboxRoot,
  defaultApprovalId,
  defaultJobId
} = require('./autonomous-loop');
const { createOpenCodePushApproval } = require('../telegram/opencode-push-approval');
const { pushOpenCodeCommit } = require('../telegram/opencode-push');
const { createOpenCodePrApproval } = require('../telegram/opencode-pr-approval');
const { createOpenCodePullRequest } = require('../telegram/opencode-pr');
const { writeDeterministicCandidatePatch } = require('./deterministic-candidate-patch-fallback');

const WIRED_LOOP_VERSION = 'autonomous_loop_wired_v0_1';
const FALLBACK_FAILURE_REASONS = new Set([
  'provider_rate_limited',
  'candidate_patch_missing',
  'agent_output_contract_violation',
  'nemoclaw_runtime_timeout',
  'nemoclaw_runtime_not_installed',
  'openshell_runtime_not_installed',
  'gateway_runtime_timeout'
]);

function oneLine(value, maxLength = 600) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function boundedSummary(result = {}) {
  return {
    ok: result.ok === true,
    stage: result.stage || null,
    reason: result.reason || null,
    command: result.command || null,
    exit_code: typeof result.exit_code === 'number' ? result.exit_code : null,
    stdout_preview: oneLine(result.stdout_preview || result.stdout || ''),
    stderr_preview: oneLine(result.stderr_preview || result.stderr || ''),
    commands_executed: Array.isArray(result.commands_executed) ? result.commands_executed.map((item) => oneLine(item, 180)).slice(0, 10) : [],
    files_modified: Array.isArray(result.files_modified) ? result.files_modified.slice(0, 50) : [],
    repository_files_modified: Array.isArray(result.repository_files_modified) ? result.repository_files_modified.slice(0, 50) : []
  };
}

function baseResult(overrides = {}) {
  return {
    ok: false,
    stage: 'autonomous_loop_wired_tick',
    version: WIRED_LOOP_VERSION,
    reason: null,
    story_id: null,
    from_phase: null,
    to_phase: null,
    story: null,
    approval_id: null,
    job_id: null,
    push: null,
    pr: null,
    push_approval: null,
    pr_approval: null,
    opencode: null,
    fallback: null,
    failure_summary: null,
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
    next_action: 'inspect_autonomous_loop_wired_failure',
    ...overrides
  };
}

function statusForPhase(phase) {
  if ([
    LOOP_PHASES.PLAN_APPROVAL_PENDING,
    LOOP_PHASES.DIFF_APPROVAL_PENDING,
    LOOP_PHASES.COMMIT_APPROVAL_PENDING,
    LOOP_PHASES.PUSH_APPROVAL_PENDING,
    LOOP_PHASES.PR_APPROVAL_PENDING
  ].includes(phase)) return STORY_STATUSES.WAITING_APPROVAL;
  if (phase === LOOP_PHASES.DONE) return STORY_STATUSES.COMPLETED;
  if (phase === LOOP_PHASES.STOPPED) return STORY_STATUSES.STOPPED;
  if (phase === LOOP_PHASES.ESCALATED) return STORY_STATUSES.FAILED;
  return STORY_STATUSES.RUNNING;
}

function nextActionForPhase(phase) {
  switch (phase) {
    case 'PUSH': return 'push_approved_commit';
    case 'PR': return 'create_approved_pull_request';
    case LOOP_PHASES.PUSH_APPROVAL_PENDING: return 'request_push_approval_then_resume';
    case LOOP_PHASES.PR_APPROVAL_PENDING: return 'request_pr_approval_then_resume';
    case LOOP_PHASES.DONE: return 'story_complete';
    case LOOP_PHASES.ESCALATED: return 'human_escalation_required';
    default: return 'advance_autonomous_loop';
  }
}

function approvalIsApproved({ rootDir, approval_id, approvals = {}, now = new Date() } = {}) {
  if (!approval_id) return false;
  if (approvals[approval_id] === 'approved') return true;
  try {
    const approval = readApproval(rootDir, approval_id);
    if (approval.status !== APPROVAL_STATUSES.APPROVED) return false;
    if (new Date(approval.expires_at).getTime() < now.getTime()) return false;
    return true;
  } catch {
    return false;
  }
}

function updateStoryForPhase(story, phase, patch, { rootDir, now, event }) {
  return updateStory(story.story_id, {
    status: statusForPhase(phase),
    current_phase: phase,
    ...patch
  }, { rootDir, now, event });
}

function branchForStory(story, env = process.env) {
  return story.current_branch || story.branch || env.RALPH_CURRENT_BRANCH || null;
}

function baseBranchForStory(story, env = process.env) {
  return story.base_branch || env.RALPH_PR_BASE_BRANCH || 'main';
}

function repositoryForStory(story, env = process.env, repository_full_name = null) {
  return repository_full_name || story.repository_full_name || story.github_issue?.repository_full_name || env.GITHUB_REPOSITORY || null;
}

function taskForFallback(story) {
  const plan = story.last_ultraplan || {};
  const task = Array.isArray(plan.tasks) ? plan.tasks.find((item) => item.agent === 'opencode') : null;
  return task?.objective || story.requirement || story.title || '';
}

function maybeFallbackAfterOpenCodeFailure(result, options) {
  const { rootDir, now, allow_runtime_code_fallback = false } = options;
  if (!result || result.ok === true) return result;
  if (result.from_phase !== LOOP_PHASES.OPENCODE_RUNNING || result.to_phase !== LOOP_PHASES.OPENCODE_RUNNING) return result;
  if (!FALLBACK_FAILURE_REASONS.has(String(result.reason || ''))) return result;

  const story = readStory(rootDir, result.story_id);
  if (!story) return result;
  const sandboxRoot = story.current_sandbox_root || defaultSandboxRoot(story);
  const approvalId = story.current_approval_id || result.approval_id || defaultApprovalId(story);
  const jobId = story.current_job_id || result.job_id || defaultJobId(story);
  const fallback = writeDeterministicCandidatePatch({
    rootDir,
    story,
    failure_reason: result.reason,
    requested_paths: story.requested_paths || [],
    sandbox_root: sandboxRoot,
    approval_id: approvalId,
    job_id: jobId,
    task: taskForFallback(story),
    now: () => now,
    allow_runtime_code: allow_runtime_code_fallback === true
  });

  if (!fallback.ok) {
    const updated = updateStory(story.story_id, {
      last_fallback_result: boundedSummary(fallback),
      patch_source: null
    }, { rootDir, now, event: 'deterministic_fallback_ineligible' });
    return {
      ...result,
      fallback,
      story: updated.summary || result.story,
      next_action: result.next_action || 'retry_or_escalate_provider_failure'
    };
  }

  const updated = updateStoryForPhase(story, LOOP_PHASES.PATCH_PREVIEW, {
    current_approval_id: approvalId,
    current_job_id: jobId,
    current_sandbox_root: sandboxRoot,
    current_candidate_patch_path: fallback.candidate_patch_path,
    current_opencode_runtime_mode: story.current_opencode_runtime_mode || 'deterministic-fallback',
    current_opencode_mediator: story.current_opencode_mediator || 'ralph',
    blocked_reason: null,
    retry_after_at: null,
    patch_source: fallback.patch_source,
    last_fallback_result: boundedSummary(fallback)
  }, { rootDir, now, event: 'deterministic_fallback_candidate_patch_created' });

  return baseResult({
    ok: true,
    reason: null,
    story_id: story.story_id,
    from_phase: LOOP_PHASES.OPENCODE_RUNNING,
    to_phase: LOOP_PHASES.PATCH_PREVIEW,
    story: updated.summary,
    approval_id: approvalId,
    job_id: jobId,
    candidate_patch_path: fallback.candidate_patch_path,
    opencode: result.opencode || null,
    fallback,
    execution_connected: false,
    commands_executed: [],
    files_modified: fallback.files_modified || [],
    repository_files_modified: [],
    next_action: 'preview_candidate_patch_and_decide_apply'
  });
}

function escalateStuckOpenCodeRunning(result, { rootDir, now } = {}) {
  if (!result || result.ok === true) return result;
  if (result.from_phase !== LOOP_PHASES.OPENCODE_RUNNING || result.to_phase !== LOOP_PHASES.OPENCODE_RUNNING) return result;

  const story = readStory(rootDir, result.story_id);
  if (!story) return result;

  const previousAttempts = Number.isInteger(story.attempts) ? story.attempts : 0;
  const maxAttempts = Number.isInteger(story.max_attempts) && story.max_attempts > 0 ? story.max_attempts : 3;
  const nextAttempts = previousAttempts + 1;

  if (nextAttempts < maxAttempts) {
    const updated = updateStory(story.story_id, {
      attempts: nextAttempts
    }, { rootDir, now, event: 'opencode_attempts_incremented' });
    return {
      ...result,
      story: updated.summary || result.story,
      attempts: nextAttempts,
      max_attempts: maxAttempts
    };
  }

  const failureSummary = {
    ok: false,
    stage: 'autonomous_loop_wired_max_attempts',
    reason: result.reason || 'opencode_dispatch_failed',
    attempts: nextAttempts,
    max_attempts: maxAttempts,
    last_blocked_reason: story.blocked_reason || result.reason || null
  };
  const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, {
    attempts: nextAttempts,
    blocked_reason: result.reason || 'opencode_dispatch_failed_max_attempts',
    last_gate_failure_summary: failureSummary,
    retry_after_at: null
  }, { rootDir, now, event: 'opencode_max_attempts_exceeded_escalated' });

  return baseResult({
    ok: false,
    reason: result.reason || 'opencode_dispatch_failed_max_attempts',
    story_id: story.story_id,
    from_phase: LOOP_PHASES.OPENCODE_RUNNING,
    to_phase: LOOP_PHASES.ESCALATED,
    story: updated.summary,
    approval_id: result.approval_id || null,
    job_id: result.job_id || null,
    opencode: result.opencode || null,
    fallback: result.fallback || null,
    failure_summary: failureSummary,
    execution_connected: result.execution_connected === true,
    commands_executed: result.commands_executed || [],
    files_modified: result.files_modified || [],
    repository_files_modified: [],
    next_action: 'human_escalation_required'
  });
}

function ensurePushApprovalAfterCommit(result, { rootDir, now, env = process.env, create_push_approval }) {
  if (!result || result.ok !== true) return result;
  if (result.from_phase !== LOOP_PHASES.COMMIT || result.to_phase !== LOOP_PHASES.PUSH_APPROVAL_PENDING) return result;
  const story = readStory(rootDir, result.story_id);
  if (!story) return result;
  const commitSha = story.current_commit_sha || result.current_commit_sha || result.commit_sha || story.last_commit_result?.commit_sha;
  const createApproval = create_push_approval || createOpenCodePushApproval;
  const pushApproval = createApproval({
    rootDir,
    commit_sha: commitSha,
    branch: branchForStory(story, env),
    remote: 'origin',
    allowed_user_ids: [],
    now
  });

  if (!pushApproval.ok) {
    const summary = boundedSummary(pushApproval);
    const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, {
      blocked_reason: pushApproval.reason || 'push_approval_create_failed',
      last_gate_failure_summary: summary,
      last_push_approval: pushApproval
    }, { rootDir, now, event: 'push_approval_create_failed' });
    return baseResult({
      ok: false,
      reason: pushApproval.reason || 'push_approval_create_failed',
      story_id: story.story_id,
      from_phase: LOOP_PHASES.COMMIT,
      to_phase: LOOP_PHASES.ESCALATED,
      story: updated.summary,
      push_approval: pushApproval,
      failure_summary: summary,
      next_action: 'human_escalation_required'
    });
  }

  const updated = updateStoryForPhase(story, LOOP_PHASES.PUSH_APPROVAL_PENDING, {
    current_approval_id: pushApproval.approval_id,
    current_commit_sha: pushApproval.commit_sha || commitSha || story.current_commit_sha || null,
    current_branch: pushApproval.branch || branchForStory(story, env),
    last_push_approval: pushApproval,
    blocked_reason: null,
    retry_after_at: null
  }, { rootDir, now, event: 'push_approval_required' });

  return baseResult({
    ok: true,
    reason: 'push_approval_required',
    story_id: story.story_id,
    from_phase: LOOP_PHASES.COMMIT,
    to_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING,
    story: updated.summary,
    push_approval: pushApproval,
    approval_id: pushApproval.approval_id,
    execution_connected: false,
    commands_executed: [],
    next_action: 'request_push_approval_then_resume'
  });
}

function resumeApprovalToExecutionPhase(story, { rootDir, now, approvals = {} }) {
  const approved = approvalIsApproved({ rootDir, approval_id: story.current_approval_id, approvals, now });
  if (!approved) return null;
  if (story.current_phase === LOOP_PHASES.PUSH_APPROVAL_PENDING) {
    const updated = updateStoryForPhase(story, 'PUSH', { blocked_reason: null, retry_after_at: null }, { rootDir, now, event: 'push_approval_resumed' });
    return baseResult({
      ok: true,
      story_id: story.story_id,
      from_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING,
      to_phase: 'PUSH',
      story: updated.summary,
      approval_id: story.current_approval_id,
      next_action: 'push_approved_commit'
    });
  }
  if (story.current_phase === LOOP_PHASES.PR_APPROVAL_PENDING) {
    const updated = updateStoryForPhase(story, 'PR', { blocked_reason: null, retry_after_at: null }, { rootDir, now, event: 'pr_approval_resumed' });
    return baseResult({
      ok: true,
      story_id: story.story_id,
      from_phase: LOOP_PHASES.PR_APPROVAL_PENDING,
      to_phase: 'PR',
      story: updated.summary,
      approval_id: story.current_approval_id,
      next_action: 'create_approved_pull_request'
    });
  }
  return null;
}

function advancePushPhase(story, { rootDir, now, env = process.env, timeout_ms, push_runner, create_pr_approval }) {
  const runner = push_runner || pushOpenCodeCommit;
  const push = runner({ rootDir, approval_id: story.current_approval_id, timeout_ms, now: () => now });
  if (!push.ok) {
    const summary = boundedSummary(push);
    const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, {
      blocked_reason: push.reason || 'push_failed',
      last_gate_failure_summary: summary,
      last_push_result: push
    }, { rootDir, now, event: 'push_failed' });
    return baseResult({
      ok: false,
      reason: push.reason || 'push_failed',
      story_id: story.story_id,
      from_phase: 'PUSH',
      to_phase: LOOP_PHASES.ESCALATED,
      story: updated.summary,
      push,
      failure_summary: summary,
      execution_connected: push.execution_connected === true,
      commands_executed: push.commands_executed || [],
      push_allowed: push.push_allowed === true,
      next_action: 'human_escalation_required'
    });
  }

  const createApproval = create_pr_approval || createOpenCodePrApproval;
  const prApproval = createApproval({
    rootDir,
    commit_sha: push.commit_sha || story.current_commit_sha,
    head_branch: push.branch || branchForStory(story, env),
    base_branch: baseBranchForStory(story, env),
    title: story.title || story.requirement || 'OpenCode change',
    body: '',
    allowed_user_ids: [],
    now
  });

  if (!prApproval.ok) {
    const summary = boundedSummary(prApproval);
    const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, {
      blocked_reason: prApproval.reason || 'pr_approval_create_failed',
      last_gate_failure_summary: summary,
      last_push_result: push,
      last_pr_approval: prApproval
    }, { rootDir, now, event: 'pr_approval_create_failed' });
    return baseResult({
      ok: false,
      reason: prApproval.reason || 'pr_approval_create_failed',
      story_id: story.story_id,
      from_phase: 'PUSH',
      to_phase: LOOP_PHASES.ESCALATED,
      story: updated.summary,
      push,
      pr_approval: prApproval,
      failure_summary: summary,
      execution_connected: push.execution_connected === true,
      commands_executed: push.commands_executed || [],
      next_action: 'human_escalation_required'
    });
  }

  const updated = updateStoryForPhase(story, LOOP_PHASES.PR_APPROVAL_PENDING, {
    current_approval_id: prApproval.approval_id,
    current_commit_sha: prApproval.commit_sha || push.commit_sha || story.current_commit_sha,
    current_branch: prApproval.head_branch || push.branch || branchForStory(story, env),
    current_base_branch: prApproval.base_branch || baseBranchForStory(story, env),
    last_push_result: push,
    last_pr_approval: prApproval,
    blocked_reason: null,
    retry_after_at: null
  }, { rootDir, now, event: 'pr_approval_required' });

  return baseResult({
    ok: true,
    reason: 'pr_approval_required',
    story_id: story.story_id,
    from_phase: 'PUSH',
    to_phase: LOOP_PHASES.PR_APPROVAL_PENDING,
    story: updated.summary,
    push,
    pr_approval: prApproval,
    approval_id: prApproval.approval_id,
    execution_connected: push.execution_connected === true,
    commands_executed: push.commands_executed || [],
    push_allowed: true,
    pr_allowed: false,
    next_action: 'request_pr_approval_then_resume'
  });
}

function advancePrPhase(story, { rootDir, now, env = process.env, githubClient, repository_full_name, pr_runner }) {
  const repository = repositoryForStory(story, env, repository_full_name);
  const runner = pr_runner || createOpenCodePullRequest;
  const pr = runner({
    rootDir,
    approval_id: story.current_approval_id,
    githubClient,
    repository_full_name: repository,
    now: () => now
  });

  if (!pr.ok) {
    const summary = boundedSummary(pr);
    const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, {
      blocked_reason: pr.reason || 'pr_failed',
      last_gate_failure_summary: summary,
      last_pr_result: pr
    }, { rootDir, now, event: 'pr_failed' });
    return baseResult({
      ok: false,
      reason: pr.reason || 'pr_failed',
      story_id: story.story_id,
      from_phase: 'PR',
      to_phase: LOOP_PHASES.ESCALATED,
      story: updated.summary,
      pr,
      failure_summary: summary,
      execution_connected: pr.execution_connected === true,
      commands_executed: pr.commands_executed || [],
      pr_allowed: pr.pr_allowed === true,
      next_action: 'human_escalation_required'
    });
  }

  const updated = updateStoryForPhase(story, LOOP_PHASES.DONE, {
    blocked_reason: null,
    retry_after_at: null,
    last_pr_result: pr,
    pr_url: pr.pr_url || null,
    pr_number: pr.pr_number || null
  }, { rootDir, now, event: 'pr_created_story_completed' });

  return baseResult({
    ok: true,
    reason: null,
    story_id: story.story_id,
    from_phase: 'PR',
    to_phase: LOOP_PHASES.DONE,
    story: updated.summary,
    pr,
    approval_id: story.current_approval_id,
    execution_connected: pr.execution_connected === true,
    commands_executed: pr.commands_executed || [],
    pr_allowed: true,
    next_action: 'story_complete'
  });
}

function tickAutonomousLoopWired(options = {}) {
  const {
    rootDir = process.cwd(),
    story_id,
    now = new Date(),
    approvals = {},
    env = process.env,
    timeout_ms,
    allow_runtime_code_fallback = false
  } = options;
  if (!story_id) return baseResult({ reason: 'story_id_required' });
  const story = readStory(rootDir, story_id);
  if (!story) return baseResult({ reason: 'story_not_found', story_id });

  if (story.current_phase === LOOP_PHASES.PUSH_APPROVAL_PENDING || story.current_phase === LOOP_PHASES.PR_APPROVAL_PENDING) {
    const resumed = resumeApprovalToExecutionPhase(story, { rootDir, now, approvals });
    if (resumed) return resumed;
  }

  if (story.current_phase === 'PUSH') return advancePushPhase(story, { ...options, rootDir, now, env, timeout_ms });
  if (story.current_phase === 'PR') return advancePrPhase(story, { ...options, rootDir, now, env });

  const result = tickAutonomousLoop(options);
  const afterFallback = maybeFallbackAfterOpenCodeFailure(result, { rootDir, now, allow_runtime_code_fallback });
  if (afterFallback.ok === true && afterFallback.to_phase === LOOP_PHASES.PATCH_PREVIEW) return afterFallback;
  const afterEscalation = escalateStuckOpenCodeRunning(afterFallback, { rootDir, now });
  if (afterEscalation !== afterFallback) return afterEscalation;
  return ensurePushApprovalAfterCommit(afterFallback, options);
}

module.exports = {
  WIRED_LOOP_VERSION,
  tickAutonomousLoopWired,
  maybeFallbackAfterOpenCodeFailure,
  escalateStuckOpenCodeRunning,
  ensurePushApprovalAfterCommit,
  resumeApprovalToExecutionPhase,
  advancePushPhase,
  advancePrPhase,
  approvalIsApproved,
  boundedSummary
};
