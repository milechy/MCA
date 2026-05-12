#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStory, updateStory, readStory, STORY_STATUSES } = require('../../src/ralph/story-queue');
const { createApproval, approveApprovalRecordOnly } = require('../../src/ralph/approval-manager');
const { APPROVAL_TYPES } = require('../../src/ralph/types');
const { resumeWithCandidatePatch } = require('../../src/ralph/runtime-operator');
const { generateDashboard } = require('../../src/ralph/dashboard');
const {
  ensurePushApprovalAfterCommit,
  resumeApprovalToExecutionPhase,
  advancePushPhase,
  advancePrPhase
} = require('../../src/ralph/autonomous-loop-wired');

const SMOKE_VERSION = 'ralph_issue_to_pr_smoke_v0_1';
const STORY_ID = 'STORY-SMOKE-ISSUE-PR';
const OPERATOR_USER_ID = 1001;
const STOP_ORDER = ['patch-preview', 'commit', 'push', 'pr', 'done'];

function oneLine(value, maxLength = 400) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '[REDACTED_SECRET]');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { fixture: false, github_live: false, stop_at: 'done', keep_tmp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') options.fixture = true;
    else if (arg === '--github-live') options.github_live = true;
    else if (arg === '--keep-tmp') options.keep_tmp = true;
    else if (arg === '--stop-at') options.stop_at = argv[index += 1] || 'done';
  }
  return options;
}

function baseResult(overrides = {}) {
  return {
    ok: false,
    stage: 'ralph_issue_to_pr_smoke',
    version: SMOKE_VERSION,
    mode: 'fixture',
    reason: null,
    story_id: STORY_ID,
    root_dir: null,
    transitions: [],
    approvals: [],
    dashboard_counts: [],
    final_story: null,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    raw_logs_included: false,
    secrets_included: false,
    bounded_output: true,
    next_action: 'inspect_smoke_failure',
    ...overrides
  };
}

function fail(reason, context = {}) {
  return baseResult({ ok: false, reason, ...context, next_action: 'fix_regression_and_rerun_smoke' });
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-issue-to-pr-smoke-'));
}

function dashboardSnapshot(rootDir, label, now) {
  const dashboard = generateDashboard({ rootDir, now, story_limit: 100, recent_limit: 25 });
  return { label, counts: dashboard.counts, next_action: dashboard.next_action };
}

function recordTransition(ctx, label, resultOrStory, now) {
  const story = resultOrStory && resultOrStory.story_id ? resultOrStory : readStory(ctx.rootDir, STORY_ID);
  ctx.transitions.push({
    label,
    status: story?.status || resultOrStory?.story?.status || null,
    phase: story?.current_phase || resultOrStory?.to_phase || resultOrStory?.story?.current_phase || null,
    approval_id: story?.current_approval_id || resultOrStory?.approval_id || null,
    job_id: story?.current_job_id || resultOrStory?.job_id || null,
    next_action: resultOrStory?.next_action || null
  });
  ctx.dashboard_counts.push(dashboardSnapshot(ctx.rootDir, label, now));
}

function assertOk(step, result) {
  if (!result || result.ok !== true) throw new Error(`${step}:${result?.reason || 'not_ok'}`);
  return result;
}

function shouldStop(stopAt, value) {
  return STOP_ORDER.indexOf(value) >= STOP_ORDER.indexOf(stopAt);
}

function writeFixtureCandidatePatch(rootDir) {
  const rel = '.ralph/tmp/opencode-sandbox/APR-SMOKE-CANDIDATE/candidate.patch';
  const abs = path.join(rootDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, [
    'diff --git a/docs/ralph-smoke-output.md b/docs/ralph-smoke-output.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/docs/ralph-smoke-output.md',
    '@@ -0,0 +1,3 @@',
    '+# Ralph smoke output',
    '+',
    '+Deterministic candidate patch fixture.',
    ''
  ].join('\n'), 'utf8');
  return rel;
}

function makeApproval(ctx, { id, type, requested_action, story_id = STORY_ID, now }) {
  const approval = createApproval({
    story_id,
    objective: requested_action,
    summary: requested_action,
    steps: [requested_action]
  }, { score: 0, category: 'low', label: 'RISK_0_LOW' }, {
    rootDir: ctx.rootDir,
    approval_id: id,
    approval_type: type,
    requested_action,
    allowed_user_ids: [OPERATOR_USER_ID],
    expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString()
  });
  const approved = approveApprovalRecordOnly(id, OPERATOR_USER_ID, { rootDir: ctx.rootDir, channel: 'smoke' });
  ctx.approvals.push({ approval_id: id, approval_type: approval.approval_type, requested_action: approval.requested_action, status: approved.status });
  return approved;
}

function updatePhase(ctx, phase, status, patch, event, now) {
  const updated = updateStory(STORY_ID, { status, current_phase: phase, ...patch }, { rootDir: ctx.rootDir, now, event });
  if (!updated.ok) throw new Error(`${event}:${updated.reason}`);
  return updated.story;
}

function runFixtureSmoke(options = {}) {
  const now = options.now || new Date('2026-05-12T00:00:00.000Z');
  const stopAt = STOP_ORDER.includes(options.stop_at) ? options.stop_at : 'done';
  const rootDir = options.rootDir || tmpRoot();
  const ctx = { rootDir, transitions: [], approvals: [], dashboard_counts: [] };

  const created = assertOk('create_story', createStory({
    story_id: STORY_ID,
    title: 'Fixture issue-to-PR smoke',
    requirement: 'Exercise Ralph issue-to-PR autonomous lifecycle without live provider calls.',
    status: STORY_STATUSES.QUEUED,
    current_phase: 'PLAN',
    mode: 'fullauto',
    target_env: 'local',
    requested_paths: ['docs/ralph-smoke-output.md'],
    github_issue: {
      issue_number: 35,
      title: 'Ralph smoke fixture issue',
      url: 'https://github.com/milechy/MCA/issues/35',
      labels: ['ralph-ready']
    }
  }, { rootDir, now }));
  recordTransition(ctx, 'issue_imported', created.story, now);

  makeApproval(ctx, { id: 'APR-SMOKE-PLAN', type: APPROVAL_TYPES.PLAN, requested_action: 'approve_smoke_plan', now });
  updatePhase(ctx, 'OPENCODE_RUNNING', STORY_STATUSES.RUNNING, { current_approval_id: null, current_job_id: 'JOB-OPENCODE-AUTO-SMOKE' }, 'smoke_plan_approved', now);
  recordTransition(ctx, 'plan_approved_opencode_running', readStory(rootDir, STORY_ID), now);

  const patchPath = writeFixtureCandidatePatch(rootDir);
  const resumed = assertOk('resume_with_candidate_patch', resumeWithCandidatePatch({ rootDir, story_id: STORY_ID, candidate_patch_path: patchPath, now, patch_source: 'deterministic_smoke_fixture' }));
  recordTransition(ctx, 'candidate_patch_ready', readStory(rootDir, STORY_ID), now);
  if (shouldStop(stopAt, 'patch-preview')) return finish(ctx, options, 'stopped_at_patch_preview', now);

  makeApproval(ctx, { id: 'APR-SMOKE-DIFF', type: APPROVAL_TYPES.DIFF, requested_action: 'approve_smoke_diff', now });
  updatePhase(ctx, 'APPLY', STORY_STATUSES.RUNNING, { current_approval_id: null, last_apply_result: { ok: true, simulated: true, candidate_patch_path: resumed.candidate_patch_path } }, 'smoke_diff_approved', now);
  recordTransition(ctx, 'diff_approved_apply', readStory(rootDir, STORY_ID), now);

  updatePhase(ctx, 'GATES', STORY_STATUSES.RUNNING, { last_gate_result: { ok: true, simulated: true, gates: ['ralph_smoke_fixture'] } }, 'smoke_gates_passed', now);
  recordTransition(ctx, 'gates_passed', readStory(rootDir, STORY_ID), now);

  makeApproval(ctx, { id: 'APR-SMOKE-COMMIT', type: APPROVAL_TYPES.PLAN, requested_action: 'approve_smoke_commit', now });
  updatePhase(ctx, 'COMMIT', STORY_STATUSES.RUNNING, { current_approval_id: 'APR-SMOKE-COMMIT', current_commit_sha: '1111111111111111111111111111111111111111' }, 'smoke_commit_approved', now);
  recordTransition(ctx, 'commit_approved', readStory(rootDir, STORY_ID), now);
  if (shouldStop(stopAt, 'commit')) return finish(ctx, options, 'stopped_at_commit', now);

  const pushApproval = makeApproval(ctx, { id: 'APR-SMOKE-PUSH', type: APPROVAL_TYPES.PLAN, requested_action: 'approve_smoke_push', now });
  const pushBoundary = assertOk('push_approval_boundary', ensurePushApprovalAfterCommit({ ok: true, story_id: STORY_ID, from_phase: 'COMMIT', to_phase: 'PUSH_APPROVAL_PENDING' }, {
    rootDir,
    now,
    create_push_approval: () => ({
      ok: true,
      stage: 'opencode_push_approval',
      approval_id: pushApproval.approval_id,
      commit_sha: '1111111111111111111111111111111111111111',
      branch: 'ralph/smoke-fixture',
      remote: 'origin',
      push_allowed: false,
      execution_connected: false,
      commands_executed: [],
      files_modified: [],
      repository_files_modified: []
    })
  }));
  recordTransition(ctx, 'push_approval_pending', readStory(rootDir, STORY_ID), now);

  const resumedPush = assertOk('resume_push_approval', resumeApprovalToExecutionPhase(readStory(rootDir, STORY_ID), { rootDir, now, approvals: { [pushBoundary.approval_id]: 'approved' } }));
  recordTransition(ctx, 'push_resumed', readStory(rootDir, STORY_ID), now);

  const prApproval = makeApproval(ctx, { id: 'APR-SMOKE-PR', type: APPROVAL_TYPES.PLAN, requested_action: 'approve_smoke_pr', now });
  const pushed = assertOk('advance_push_phase', advancePushPhase(readStory(rootDir, STORY_ID), {
    rootDir,
    now,
    push_runner: () => ({
      ok: true,
      stage: 'opencode_push',
      approval_id: resumedPush.approval_id,
      commit_sha: '1111111111111111111111111111111111111111',
      branch: 'ralph/smoke-fixture',
      remote: 'origin',
      execution_connected: false,
      push_allowed: true,
      commands_executed: ['simulated git push origin HEAD:<approved_branch>'],
      files_modified: [],
      repository_files_modified: [],
      push_performed: false,
      simulated: true
    }),
    create_pr_approval: () => ({
      ok: true,
      stage: 'opencode_pr_approval',
      approval_id: prApproval.approval_id,
      commit_sha: '1111111111111111111111111111111111111111',
      head_branch: 'ralph/smoke-fixture',
      base_branch: 'main',
      title: 'Fixture issue-to-PR smoke',
      pr_allowed: false,
      execution_connected: false,
      commands_executed: [],
      files_modified: [],
      repository_files_modified: []
    })
  }));
  recordTransition(ctx, 'pr_approval_pending', readStory(rootDir, STORY_ID), now);
  if (shouldStop(stopAt, 'push')) return finish(ctx, options, 'stopped_at_push', now);

  const resumedPr = assertOk('resume_pr_approval', resumeApprovalToExecutionPhase(readStory(rootDir, STORY_ID), { rootDir, now, approvals: { [pushed.approval_id]: 'approved' } }));
  recordTransition(ctx, 'pr_resumed', readStory(rootDir, STORY_ID), now);

  const pr = assertOk('advance_pr_phase', advancePrPhase(readStory(rootDir, STORY_ID), {
    rootDir,
    now,
    pr_runner: () => ({
      ok: true,
      stage: 'opencode_pr',
      approval_id: resumedPr.approval_id,
      commit_sha: '1111111111111111111111111111111111111111',
      head_branch: 'ralph/smoke-fixture',
      base_branch: 'main',
      title: 'Fixture issue-to-PR smoke',
      pr_url: 'https://github.com/milechy/MCA/pull/0',
      pr_number: 0,
      execution_connected: false,
      pr_allowed: true,
      commands_executed: ['simulated github.createPullRequest'],
      files_modified: [],
      repository_files_modified: [],
      pr_created: false,
      simulated: true
    })
  }));
  recordTransition(ctx, 'pr_created_done', readStory(rootDir, STORY_ID), now);
  if (shouldStop(stopAt, 'pr')) return finish(ctx, options, 'stopped_at_pr', now);

  return finish(ctx, options, null, now, { pr });
}

function finish(ctx, options, stoppedReason, now, extra = {}) {
  const finalStory = readStory(ctx.rootDir, STORY_ID);
  const dashboard = generateDashboard({ rootDir: ctx.rootDir, now, story_limit: 100, recent_limit: 25 });
  const completed = finalStory?.current_phase === 'DONE' && finalStory?.status === STORY_STATUSES.COMPLETED;
  const stoppedOk = Boolean(stoppedReason);
  const ok = stoppedOk || completed;
  return baseResult({
    ok,
    reason: stoppedReason,
    mode: 'fixture',
    root_dir: options.keep_tmp ? ctx.rootDir : '[temporary] ',
    transitions: ctx.transitions,
    approvals: ctx.approvals,
    dashboard_counts: ctx.dashboard_counts,
    final_dashboard_counts: dashboard.counts,
    final_story: finalStory ? {
      story_id: finalStory.story_id,
      status: finalStory.status,
      current_phase: finalStory.current_phase,
      current_approval_id: finalStory.current_approval_id || null,
      current_candidate_patch_path: finalStory.current_candidate_patch_path || null,
      pr_url: finalStory.pr_url || null,
      pr_number: finalStory.pr_number ?? null
    } : null,
    push_performed: false,
    pr_created: false,
    files_modified: [],
    repository_files_modified: [],
    next_action: ok ? (stoppedReason || 'smoke_passed') : 'inspect_smoke_failure',
    ...extra
  });
}

function runSmoke(options = parseArgs()) {
  if (options.github_live && process.env.RALPH_E2E_SMOKE_GITHUB_LIVE !== '1') {
    return fail('github_live_requires_RALPH_E2E_SMOKE_GITHUB_LIVE', { mode: 'github-live', next_action: 'set_explicit_live_gate_or_use_fixture' });
  }
  if (!options.fixture && !options.github_live) options.fixture = true;
  if (options.github_live) return fail('github_live_mode_not_implemented_in_default_smoke', { mode: 'github-live' });
  try {
    return runFixtureSmoke(options);
  } catch (error) {
    return fail('smoke_exception', { error_preview: oneLine(error && error.message ? error.message : error) });
  }
}

if (require.main === module) {
  const result = runSmoke(parseArgs());
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

module.exports = {
  SMOKE_VERSION,
  parseArgs,
  runSmoke,
  runFixtureSmoke
};
