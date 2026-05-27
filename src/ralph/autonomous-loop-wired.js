const { readStory, updateStory, summarizeStory, STORY_STATUSES } = require('./story-queue');
const { readApproval } = require('./approval-manager');
const { APPROVAL_STATUSES } = require('./types');
const {
  LOOP_PHASES,
  tickAutonomousLoop,
  defaultSandboxRoot,
  defaultApprovalId,
  defaultJobId,
  opencodeKimiDirectEnabled,
  nemoclawDispatcherExplicitlyEnabled
} = require('./autonomous-loop');
const { createOpenCodePushApproval } = require('../telegram/opencode-push-approval');
const { pushOpenCodeCommit } = require('../telegram/opencode-push');
const { createOpenCodePrApproval } = require('../telegram/opencode-pr-approval');
const { createOpenCodePullRequest } = require('../telegram/opencode-pr');
const { writeDeterministicCandidatePatch } = require('./deterministic-candidate-patch-fallback');
const { buildDefaultGithubPrClient } = require('./github-pr-client');
const { buildPrBody } = require('./pr-body-generator');
const { maybeAutoApproveForFullauto } = require('./fullauto-auto-approver');
const { consumeApprovedResume } = require('./resume-after-security-stop');
const { reviewPullRequest: defaultReviewPullRequest, postReviewToPR: defaultPostReviewToPR } = require('./pr-reviewer');

// Phase 4 #4: opt-in PR_REVIEW phase. When RALPH_PR_REVIEW_ENABLED=1, the
// daemon inserts a PR_REVIEW phase between PR creation and DONE. The phase
// calls reviewPullRequest() (Phase 4 #3) and records the review in the
// story audit.
// Phase 5 #4: when RALPH_PR_REVIEW_AUTO_REPAIR=1 and the reviewer verdict is
// request_changes, branch back into FIX_LOOP with the reviewer's issues
// translated into a repair instruction. Bounded by a separate attempt
// counter (story.review_repair_attempts vs the gate-failure attempts) so a
// review-driven loop cannot exhaust the gate-repair budget.
function prReviewEnabled(env = process.env) {
  const raw = env && env.RALPH_PR_REVIEW_ENABLED;
  if (raw == null) return false;
  const normalized = String(raw).toLowerCase().trim();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function prReviewAutoRepairEnabled(env = process.env) {
  const raw = env && env.RALPH_PR_REVIEW_AUTO_REPAIR;
  if (raw == null) return false;
  const normalized = String(raw).toLowerCase().trim();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

// Phase 5 #4: hard cap on review-driven re-dispatches. We don't share with
// story.max_attempts (which is the GATE-failure budget) because a single
// review pass can already exhaust the gate budget; reusing that counter
// would either lock the repair out entirely or risk infinite ping-pong
// between gates and reviewer.
const DEFAULT_REVIEW_REPAIR_ATTEMPT_CAP = 1;

// Phase 5 #4: translate a request_changes reviewer verdict into a Kimi-
// friendly repair instruction. Only blocker / warn issues are forwarded
// (nits are intentionally dropped from the auto-repair path — they are
// observational and should not trigger work). Returns null when the
// review has no actionable issues, which signals the caller to skip the
// auto-repair branch and complete normally.
function buildReviewRepairInstruction(review) {
  if (!review || review.ok !== true) return null;
  if (review.verdict !== 'request_changes') return null;
  const issues = Array.isArray(review.issues) ? review.issues : [];
  const actionable = issues.filter((issue) => issue && (issue.severity === 'blocker' || issue.severity === 'warn'));
  if (actionable.length === 0) return null;
  const lines = [
    'The autonomous PR reviewer requested changes on the open PR for this story.',
    '',
    `Reviewer summary: ${String(review.summary || '(no summary)').slice(0, 600)}`,
    '',
    'Address the following issues. Preserve all pre-existing tests, functions, exports, and comments verbatim — only change the lines specifically required by each issue.',
    '',
    'Issues to fix:'
  ];
  for (const issue of actionable.slice(0, 15)) {
    const loc = issue.file ? `${issue.file}${issue.line ? ':' + issue.line : ''}` : '(unspecified file)';
    const msg = String(issue.message || '').slice(0, 400).replace(/[\r\n\t]+/g, ' ');
    lines.push(`- [${issue.severity}] ${loc} — ${msg}`);
  }
  if (actionable.length > 15) {
    lines.push(`- (+${actionable.length - 15} more issues truncated; address the most severe first)`);
  }
  lines.push('');
  lines.push('Land these as a follow-up commit on the same branch. Do NOT delete the existing tests added in the original story.');
  return lines.join('\n');
}

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

const REMOTE_HEAD_DEFAULT_BRANCH_TIMEOUT_MS = 5000;
let cachedRemoteHeadDefaultBranch = null;

function resolveRemoteHeadDefaultBranch(rootDir, { spawn = require('node:child_process').spawnSync, env = process.env } = {}) {
  if (cachedRemoteHeadDefaultBranch) return cachedRemoteHeadDefaultBranch;
  if (!rootDir) return null;
  try {
    const result = spawn('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: rootDir,
      env: { PATH: env.PATH, HOME: env.HOME, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      timeout: REMOTE_HEAD_DEFAULT_BRANCH_TIMEOUT_MS
    });
    if (result.status !== 0) return null;
    const stdout = String(result.stdout || '').trim();
    const stripped = stdout.startsWith('origin/') ? stdout.slice('origin/'.length) : stdout;
    if (!stripped || !/^[A-Za-z0-9_./-]+$/.test(stripped)) return null;
    cachedRemoteHeadDefaultBranch = stripped;
    return stripped;
  } catch {
    return null;
  }
}

function resetBaseBranchCacheForTests() {
  cachedRemoteHeadDefaultBranch = null;
}

function baseBranchForStory(story, env = process.env, options = {}) {
  if (story && story.base_branch) return story.base_branch;
  if (env && env.RALPH_PR_BASE_BRANCH) return env.RALPH_PR_BASE_BRANCH;
  const rootDir = options.rootDir;
  if (rootDir) {
    const detected = resolveRemoteHeadDefaultBranch(rootDir, options);
    if (detected) return detected;
  }
  return 'main';
}

const SAFE_REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
let cachedDetectedRepo = null;

function detectRepositoryFromGitRemote(rootDir, { spawn = require('node:child_process').spawnSync, env = process.env, timeout = 5000 } = {}) {
  if (cachedDetectedRepo !== null) return cachedDetectedRepo;
  if (!rootDir) return null;
  try {
    const result = spawn('git', ['config', '--get', 'remote.origin.url'], {
      cwd: rootDir,
      env: { PATH: env.PATH, HOME: env.HOME, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      timeout
    });
    if (result.status !== 0) { cachedDetectedRepo = null; return null; }
    const url = String(result.stdout || '').trim();
    // Match https://github.com/owner/repo(.git)? or git@github.com:owner/repo(.git)?
    const m = url.match(/^(?:https?:\/\/[^/]+\/|git@[^:]+:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
    if (!m || !SAFE_REPO_FULL_NAME.test(m[1])) { cachedDetectedRepo = null; return null; }
    cachedDetectedRepo = m[1];
    return cachedDetectedRepo;
  } catch {
    return null;
  }
}

function resetRepositoryDetectionCacheForTests() {
  cachedDetectedRepo = null;
}

function repositoryForStory(story, env = process.env, repository_full_name = null, options = {}) {
  const candidate = repository_full_name
    || (story && story.repository_full_name)
    || (story && story.github_issue && story.github_issue.repository_full_name)
    || env.GITHUB_REPOSITORY
    || (options.rootDir ? detectRepositoryFromGitRemote(options.rootDir, options) : null);
  if (!candidate) return null;
  return SAFE_REPO_FULL_NAME.test(String(candidate)) ? candidate : null;
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
  // Phase 1 #10: same downgrade as the sandbox preflight — when the
  // dispatcher uses git-worktree isolation, an incidentally dirty main
  // working tree (from a parallel story's mid-APPLY) must not escalate this
  // story's push approval. Bug G regression guard.
  const worktreeIsolated = opencodeKimiDirectEnabled(env) || !nemoclawDispatcherExplicitlyEnabled(env);
  const pushApproval = createApproval({
    rootDir,
    commit_sha: commitSha,
    branch: branchForStory(story, env),
    remote: 'origin',
    allowed_user_ids: [],
    now,
    worktree_isolated: worktreeIsolated
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
  // Phase 1 #10: same worktree_isolated downgrade for the execution preflight.
  const worktreeIsolated = opencodeKimiDirectEnabled(env) || !nemoclawDispatcherExplicitlyEnabled(env);
  const push = runner({ rootDir, approval_id: story.current_approval_id, timeout_ms, now: () => now, worktree_isolated: worktreeIsolated });
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
  // Phase 1 #14: reuse the worktreeIsolated computed earlier in this function
  // for the push step. Same downgrade pattern as Phase 1 #10/#13 applied to
  // PR-approval creation (HEAD vs branch-tip + dirty downgrade).
  const prApproval = createApproval({
    rootDir,
    commit_sha: push.commit_sha || story.current_commit_sha,
    head_branch: push.branch || branchForStory(story, env),
    base_branch: baseBranchForStory(story, env, { rootDir }),
    title: story.title || story.requirement || 'OpenCode change',
    body: buildPrBody({ story, ultraplan: story.last_ultraplan || {}, changed_files: story.repository_files_modified || story.files_modified || story.requested_paths || [], gates: story.last_gate_result || {}, approvals: [], plan_hash: story.current_plan_hash, diff_hash: story.current_patch_hash }).body,
    allowed_user_ids: [],
    now,
    worktree_isolated: worktreeIsolated
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
    current_base_branch: prApproval.base_branch || baseBranchForStory(story, env, { rootDir }),
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
  const repository = repositoryForStory(story, env, repository_full_name, { rootDir });
  const runner = pr_runner || createOpenCodePullRequest;
  // If the caller did not inject a github client, build the default one from
  // `gh` CLI. The default client is policy-bounded (validates repo / branch
  // shape, scrubs env down to PATH/HOME/GH_TOKEN, 30s timeout). Operators or
  // tests can still pass their own githubClient to override.
  const effectiveClient = githubClient || buildDefaultGithubPrClient({ env });
  // Phase 1 #14: forward worktree_isolated to the PR preflight, same as
  // Phase 1 #10/#13 pattern.
  const worktreeIsolated = opencodeKimiDirectEnabled(env) || !nemoclawDispatcherExplicitlyEnabled(env);
  const pr = runner({
    rootDir,
    approval_id: story.current_approval_id,
    githubClient: effectiveClient,
    repository_full_name: repository,
    now: () => now,
    worktree_isolated: worktreeIsolated
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

  // Phase 4 #4: when RALPH_PR_REVIEW_ENABLED is set and we have a PR number,
  // transition to the new PR_REVIEW phase so the next tick can call the
  // reviewer. Otherwise preserve the existing PR → DONE behavior.
  const reviewEnabled = prReviewEnabled(env);
  // Reviewer needs an actual PR number — null/undefined/0 skip the phase.
  const hasPrNumber = pr && pr.pr_number != null && Number.isInteger(pr.pr_number) && pr.pr_number > 0;
  const nextPhase = (reviewEnabled && hasPrNumber) ? LOOP_PHASES.PR_REVIEW : LOOP_PHASES.DONE;
  const nextEvent = (reviewEnabled && hasPrNumber) ? 'pr_created_pending_review' : 'pr_created_story_completed';

  const updated = updateStoryForPhase(story, nextPhase, {
    blocked_reason: null,
    retry_after_at: null,
    last_pr_result: pr,
    pr_url: pr.pr_url || null,
    pr_number: pr.pr_number || null
  }, { rootDir, now, event: nextEvent });

  return baseResult({
    ok: true,
    reason: null,
    story_id: story.story_id,
    from_phase: 'PR',
    to_phase: nextPhase,
    story: updated.summary,
    pr,
    approval_id: story.current_approval_id,
    execution_connected: pr.execution_connected === true,
    commands_executed: pr.commands_executed || [],
    pr_allowed: true,
    next_action: nextPhase === LOOP_PHASES.PR_REVIEW ? 'review_pull_request_then_complete' : 'story_complete'
  });
}

function advancePrReviewPhase(story, { rootDir, now, env = process.env, pr_reviewer, pr_review_poster } = {}) {
  const reviewer = pr_reviewer || defaultReviewPullRequest;
  // Phase 8 #0: postReviewToPR is injectable for tests; in production it
  // shells out to `gh pr review`. Default is the real implementation;
  // tests pass a fake to avoid hitting GitHub.
  const reviewPoster = pr_review_poster || defaultPostReviewToPR;
  const prNumber = story.pr_number;
  // Defensive: should not happen because advancePrPhase only enters PR_REVIEW
  // when pr_number is present, but guard anyway for resumed/imported stories.
  if (prNumber == null) {
    const updated = updateStoryForPhase(story, LOOP_PHASES.DONE, {
      blocked_reason: null,
      last_review_result: { ok: false, reason: 'pr_number_missing_skipped_review' }
    }, { rootDir, now, event: 'pr_review_skipped_missing_pr_number' });
    return baseResult({
      ok: true,
      reason: 'pr_number_missing_skipped_review',
      story_id: story.story_id,
      from_phase: LOOP_PHASES.PR_REVIEW,
      to_phase: LOOP_PHASES.DONE,
      story: updated.summary,
      next_action: 'story_complete'
    });
  }

  const review = reviewer({ pr_number: prNumber, rootDir, env, now: () => now });

  // The reviewer can fail for environmental reasons (gh down, OpenRouter
  // outage, malformed reply after retries). In v1 we treat those as
  // "review not performed" — the story still completes, with the failure
  // recorded in the audit so dashboards can surface it.
  const reviewOk = review && review.ok === true;
  const summarySnapshot = reviewOk ? {
    ok: true,
    verdict: review.verdict,
    summary: review.summary,
    issue_count: Array.isArray(review.issues) ? review.issues.length : 0,
    cost_usd: review.cost_usd || 0,
    reviewer_model: review.reviewer_model || null,
    diff_truncated: review.diff_truncated === true
  } : {
    ok: false,
    reason: (review && review.reason) || 'reviewer_unavailable'
  };

  // Phase 8 #0: post the reviewer's verdict to the actual GitHub PR via
  // `gh pr review`. Phase 5 #3 (#163) created postReviewToPR but never wired
  // it into the daemon, so Phase 7 #4 smoke v4 (PR #175) recorded the
  // verdict in story.last_review_result but the PR itself had no comment.
  // postReviewToPR honors its own opt-in env (RALPH_PR_REVIEW_POST_COMMENT)
  // and is no-throw on any error; we attach the result to the summary for
  // observability and DO NOT block the loop on post failures (the verdict
  // is still recorded in audit + story.last_review_result either way).
  let post = null;
  if (reviewOk) {
    try {
      post = reviewPoster({ pr_number: prNumber, result: review, env });
    } catch (_err) {
      post = { ok: false, posted: false, reason: 'post_review_threw' };
    }
    summarySnapshot.post = post;
  }

  // Phase 5 #4: branch on verdict=request_changes when the auto-repair flag
  // is set. Three escape hatches keep this safe:
  //   (a) auto-repair must be explicitly opted in via env;
  //   (b) buildReviewRepairInstruction returns null when there are no
  //       actionable (blocker/warn) issues — nit-only reviews still go to
  //       DONE so we don't burn budget on stylistic preferences;
  //   (c) review_repair_attempts is bounded by DEFAULT_REVIEW_REPAIR_ATTEMPT_CAP
  //       so a stubborn reviewer cannot create an infinite loop.
  const autoRepairOn = prReviewAutoRepairEnabled(env);
  const repairInstruction = reviewOk && autoRepairOn
    ? buildReviewRepairInstruction(review)
    : null;
  const priorRepairAttempts = Number.isInteger(story.review_repair_attempts) ? story.review_repair_attempts : 0;
  const repairCap = Number.isInteger(story.review_repair_cap) ? story.review_repair_cap : DEFAULT_REVIEW_REPAIR_ATTEMPT_CAP;
  const wantsRepair = reviewOk
    && autoRepairOn
    && review.verdict === 'request_changes'
    && repairInstruction != null
    && priorRepairAttempts < repairCap;

  const nextPhase = wantsRepair ? LOOP_PHASES.FIX_LOOP : LOOP_PHASES.DONE;

  // When we go to FIX_LOOP, populate last_repair_instruction so the existing
  // FIX_LOOP machinery (autonomous-loop.js::taskForStory) picks it up and
  // appends it to the next opencode dispatch task. Increment the bounded
  // review-repair counter so we cap re-dispatches.
  const updateFields = wantsRepair
    ? {
        blocked_reason: null,
        retry_after_at: null,
        last_review_result: summarySnapshot,
        last_repair_instruction: repairInstruction,
        review_repair_attempts: priorRepairAttempts + 1,
        review_repair_cap: repairCap
      }
    : {
        blocked_reason: null,
        retry_after_at: null,
        last_review_result: summarySnapshot
      };

  const event = !reviewOk
    ? 'pr_review_failed_story_still_completed'
    : wantsRepair
      ? `pr_review_requested_changes_fix_loop_dispatched_attempt_${priorRepairAttempts + 1}`
      : `pr_review_completed_verdict_${review.verdict}`;

  const updated = updateStoryForPhase(story, nextPhase, updateFields, { rootDir, now, event });

  return baseResult({
    ok: true,
    reason: reviewOk ? null : summarySnapshot.reason,
    story_id: story.story_id,
    from_phase: LOOP_PHASES.PR_REVIEW,
    to_phase: nextPhase,
    story: updated.summary,
    review: summarySnapshot,
    review_repair_dispatched: wantsRepair,
    review_repair_attempts: wantsRepair ? priorRepairAttempts + 1 : priorRepairAttempts,
    next_action: wantsRepair ? 'dispatch_opencode_fix_candidate_patch_via_nemoclaw' : 'story_complete'
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
  let story = readStory(rootDir, story_id);
  if (!story) return baseResult({ reason: 'story_not_found', story_id });

  // If the story was previously security-stopped, consult the resume registry
  // first. consumeApprovedResume will only succeed when an admin-recorded,
  // human-APPROVED RESUME_AFTER_SECURITY_STOP record is present and unexpired;
  // it can never be flipped by the fullauto auto-approver. On success the
  // story is re-armed to PLAN_APPROVAL_PENDING so the very next tick re-runs
  // risk assessment and a fresh ControlDecision.
  if (
    story.current_phase === 'STOPPED_SECURITY'
    || story.current_phase === LOOP_PHASES.STOPPED
    || story.status === 'stopped'
    || story.status === 'failed'
  ) {
    const resumed = consumeApprovedResume({ rootDir, story_id, now });
    if (resumed && resumed.ok === true && resumed.transitioned === true) {
      // Re-read the freshly transitioned story; fall through to normal handling.
      story = readStory(rootDir, story_id);
    }
  }

  // For PUSH / PR approval boundaries the wired loop has its own resume path
  // (resumeApprovalToExecutionPhase) that drives the actual execution rather
  // than the inner-loop's pure phase advance. Auto-approve via the fullauto
  // approver BEFORE consulting the resume path, so a fullauto-eligible PUSH or
  // PR approval can flow through the real push / PR-creation work instead of
  // skipping straight to the next approval phase via the inner-loop switch.
  if (
    story.current_phase === LOOP_PHASES.PUSH_APPROVAL_PENDING
    || story.current_phase === LOOP_PHASES.PR_APPROVAL_PENDING
    || story.current_phase === LOOP_PHASES.COMMIT_APPROVAL_PENDING
    || story.current_phase === LOOP_PHASES.DIFF_APPROVAL_PENDING
  ) {
    maybeAutoApproveForFullauto({ rootDir, story, now });
  }

  if (story.current_phase === LOOP_PHASES.PUSH_APPROVAL_PENDING || story.current_phase === LOOP_PHASES.PR_APPROVAL_PENDING) {
    const resumed = resumeApprovalToExecutionPhase(story, { rootDir, now, approvals });
    if (resumed) return resumed;
  }

  if (story.current_phase === 'PUSH') return advancePushPhase(story, { ...options, rootDir, now, env, timeout_ms });
  if (story.current_phase === 'PR') return advancePrPhase(story, { ...options, rootDir, now, env });
  if (story.current_phase === LOOP_PHASES.PR_REVIEW) return advancePrReviewPhase(story, { ...options, rootDir, now, env });

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
  advancePrReviewPhase,
  prReviewEnabled,
  prReviewAutoRepairEnabled,
  buildReviewRepairInstruction,
  DEFAULT_REVIEW_REPAIR_ATTEMPT_CAP,
  baseBranchForStory,
  resolveRemoteHeadDefaultBranch,
  resetBaseBranchCacheForTests,
  repositoryForStory,
  detectRepositoryFromGitRemote,
  resetRepositoryDetectionCacheForTests,
  approvalIsApproved,
  boundedSummary
};
