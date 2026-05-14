const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory, updateStory, STORY_STATUSES } = require('../../src/ralph/story-queue');
const { LOOP_PHASES } = require('../../src/ralph/autonomous-loop');
const {
  tickAutonomousLoopWired,
  maybeFallbackAfterOpenCodeFailure,
  escalateStuckOpenCodeRunning,
  ensurePushApprovalAfterCommit,
  resumeApprovalToExecutionPhase,
  advancePushPhase,
  advancePrPhase
} = require('../../src/ralph/autonomous-loop-wired');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autonomous-loop-wired-'));
}

function seed(rootDir, overrides = {}) {
  const created = createStory({
    story_id: 'STORY-WIRED',
    title: 'Wire lifecycle phases',
    requirement: 'Wire push and PR phases for Ralph autonomous loop.',
    mode: 'fullauto',
    target_env: 'local',
    requested_paths: ['docs/wired-fallback.md'],
    risk: { score: 0, category: 'low', label: 'RISK_0_LOW' },
    ...overrides
  }, { rootDir, now: new Date('2026-05-12T12:00:00.000Z') });
  expect(created.ok).toBe(true);
  return created.story;
}

test('maybeFallbackAfterOpenCodeFailure converts eligible provider rate limit into PATCH_PREVIEW', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.RUNNING,
    current_phase: LOOP_PHASES.OPENCODE_RUNNING,
    current_approval_id: 'APR-FALLBACK',
    current_job_id: 'JOB-FALLBACK',
    current_sandbox_root: '.ralph/tmp/opencode-sandbox/APR-FALLBACK'
  });

  const result = maybeFallbackAfterOpenCodeFailure({
    ok: false,
    reason: 'provider_rate_limited',
    story_id: 'STORY-WIRED',
    from_phase: LOOP_PHASES.OPENCODE_RUNNING,
    to_phase: LOOP_PHASES.OPENCODE_RUNNING,
    approval_id: 'APR-FALLBACK',
    job_id: 'JOB-FALLBACK',
    next_action: 'retry_after_provider_rate_limit'
  }, { rootDir, now: new Date('2026-05-12T12:01:00.000Z') });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    from_phase: LOOP_PHASES.OPENCODE_RUNNING,
    to_phase: LOOP_PHASES.PATCH_PREVIEW,
    approval_id: 'APR-FALLBACK',
    job_id: 'JOB-FALLBACK',
    candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-OPENCODE-AUTO-WIRED/candidate.patch',
    fallback: { ok: true, patch_source: 'deterministic_fallback' },
    apply_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    next_action: 'preview_candidate_patch_and_decide_apply'
  });
  const story = readStory(rootDir, 'STORY-WIRED');
  expect(story).toMatchObject({
    status: STORY_STATUSES.RUNNING,
    current_phase: LOOP_PHASES.PATCH_PREVIEW,
    patch_source: 'deterministic_fallback',
    current_candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-OPENCODE-AUTO-WIRED/candidate.patch'
  });
  expect(fs.existsSync(path.join(rootDir, '.ralph/tmp/opencode-sandbox/APR-OPENCODE-AUTO-WIRED/candidate.patch'))).toBe(true);
  expect(fs.existsSync(path.join(rootDir, 'docs/wired-fallback.md'))).toBe(false);
});

test('maybeFallbackAfterOpenCodeFailure leaves ineligible failures on original retry path', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.RUNNING,
    current_phase: LOOP_PHASES.OPENCODE_RUNNING,
    requested_paths: ['src/runtime-change.js'],
    current_sandbox_root: '.ralph/tmp/opencode-sandbox/APR-FALLBACK'
  });

  const original = {
    ok: false,
    reason: 'provider_rate_limited',
    story_id: 'STORY-WIRED',
    from_phase: LOOP_PHASES.OPENCODE_RUNNING,
    to_phase: LOOP_PHASES.OPENCODE_RUNNING,
    next_action: 'retry_after_provider_rate_limit'
  };
  const result = maybeFallbackAfterOpenCodeFailure(original, { rootDir, now: new Date('2026-05-12T12:01:00.000Z') });

  expect(result).toMatchObject({
    ok: false,
    reason: 'provider_rate_limited',
    from_phase: LOOP_PHASES.OPENCODE_RUNNING,
    to_phase: LOOP_PHASES.OPENCODE_RUNNING,
    fallback: { ok: false, reason: 'fallback_requested_path_not_policy_allowed' }
  });
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({ current_phase: LOOP_PHASES.OPENCODE_RUNNING });
});

test('escalateStuckOpenCodeRunning increments attempts then escalates at max_attempts', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.RUNNING,
    current_phase: LOOP_PHASES.OPENCODE_RUNNING,
    requested_paths: ['src/runtime-change.js'],
    max_attempts: 2
  });

  const stuck = {
    ok: false,
    reason: 'nemoclaw_runtime_timeout',
    story_id: 'STORY-WIRED',
    from_phase: LOOP_PHASES.OPENCODE_RUNNING,
    to_phase: LOOP_PHASES.OPENCODE_RUNNING,
    next_action: 'fix_nemoclaw_gateway_failure'
  };

  const firstAttempt = escalateStuckOpenCodeRunning(stuck, { rootDir, now: new Date('2026-05-12T12:02:00.000Z') });
  expect(firstAttempt.attempts).toBe(1);
  expect(firstAttempt.to_phase).toBe(LOOP_PHASES.OPENCODE_RUNNING);
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({ attempts: 1, current_phase: LOOP_PHASES.OPENCODE_RUNNING });

  const secondAttempt = escalateStuckOpenCodeRunning(stuck, { rootDir, now: new Date('2026-05-12T12:03:00.000Z') });
  expect(secondAttempt).toMatchObject({
    ok: false,
    reason: 'nemoclaw_runtime_timeout',
    from_phase: LOOP_PHASES.OPENCODE_RUNNING,
    to_phase: LOOP_PHASES.ESCALATED,
    next_action: 'human_escalation_required'
  });
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({
    attempts: 2,
    current_phase: LOOP_PHASES.ESCALATED,
    status: STORY_STATUSES.FAILED
  });
});

test('escalateStuckOpenCodeRunning ignores non-stuck or successful results', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.RUNNING,
    current_phase: LOOP_PHASES.OPENCODE_RUNNING
  });

  const success = { ok: true, story_id: 'STORY-WIRED', from_phase: LOOP_PHASES.OPENCODE_RUNNING, to_phase: LOOP_PHASES.PATCH_PREVIEW };
  expect(escalateStuckOpenCodeRunning(success, { rootDir, now: new Date() })).toBe(success);

  const progressed = { ok: false, story_id: 'STORY-WIRED', from_phase: LOOP_PHASES.PLAN, to_phase: LOOP_PHASES.OPENCODE_RUNNING, reason: 'plan_decision' };
  expect(escalateStuckOpenCodeRunning(progressed, { rootDir, now: new Date() })).toBe(progressed);

  expect(readStory(rootDir, 'STORY-WIRED').attempts).toBe(0);
});

test('ensurePushApprovalAfterCommit replaces commit completion with push approval metadata', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.WAITING_APPROVAL,
    current_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING,
    current_commit_sha: 'abc123',
    current_branch: 'feature/wired'
  });

  const result = ensurePushApprovalAfterCommit({
    ok: true,
    story_id: 'STORY-WIRED',
    from_phase: LOOP_PHASES.COMMIT,
    to_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING
  }, {
    rootDir,
    now: new Date('2026-05-12T12:02:00.000Z'),
    create_push_approval: () => ({
      ok: true,
      stage: 'opencode_push_approval',
      approval_id: 'APR-PUSH',
      commit_sha: 'abc123',
      branch: 'feature/wired',
      remote: 'origin',
      push_allowed: false,
      execution_connected: false,
      commands_executed: [],
      files_modified: [],
      repository_files_modified: [],
      next_action: 'approve_or_deny_push_before_git_push'
    })
  });

  expect(result).toMatchObject({
    ok: true,
    reason: 'push_approval_required',
    from_phase: LOOP_PHASES.COMMIT,
    to_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING,
    approval_id: 'APR-PUSH',
    push_approval: { approval_id: 'APR-PUSH' },
    next_action: 'request_push_approval_then_resume'
  });
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({
    status: STORY_STATUSES.WAITING_APPROVAL,
    current_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING,
    current_approval_id: 'APR-PUSH',
    current_commit_sha: 'abc123',
    current_branch: 'feature/wired'
  });
});

test('resumeApprovalToExecutionPhase resumes push approval to PUSH not PR approval', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.WAITING_APPROVAL,
    current_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING,
    current_approval_id: 'APR-PUSH'
  });

  const result = resumeApprovalToExecutionPhase(readStory(rootDir, 'STORY-WIRED'), {
    rootDir,
    now: new Date('2026-05-12T12:03:00.000Z'),
    approvals: { 'APR-PUSH': 'approved' }
  });

  expect(result).toMatchObject({
    ok: true,
    from_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING,
    to_phase: 'PUSH',
    approval_id: 'APR-PUSH',
    next_action: 'push_approved_commit'
  });
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({
    status: STORY_STATUSES.RUNNING,
    current_phase: 'PUSH'
  });
});

test('advancePushPhase creates PR approval after controlled push succeeds', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.RUNNING,
    current_phase: 'PUSH',
    current_approval_id: 'APR-PUSH',
    current_commit_sha: 'abc123',
    current_branch: 'feature/wired',
    base_branch: 'main'
  });

  const result = advancePushPhase(readStory(rootDir, 'STORY-WIRED'), {
    rootDir,
    now: new Date('2026-05-12T12:04:00.000Z'),
    push_runner: () => ({
      ok: true,
      stage: 'opencode_push',
      approval_id: 'APR-PUSH',
      commit_sha: 'abc123',
      branch: 'feature/wired',
      remote: 'origin',
      execution_connected: true,
      push_allowed: true,
      commands_executed: ['git push origin HEAD:<approved_branch>'],
      files_modified: [],
      repository_files_modified: [],
      push_performed: true
    }),
    create_pr_approval: () => ({
      ok: true,
      stage: 'opencode_pr_approval',
      approval_id: 'APR-PR',
      commit_sha: 'abc123',
      head_branch: 'feature/wired',
      base_branch: 'main',
      pr_allowed: false,
      execution_connected: false,
      commands_executed: [],
      files_modified: [],
      repository_files_modified: [],
      next_action: 'approve_or_deny_pr_before_github_pr_creation'
    })
  });

  expect(result).toMatchObject({
    ok: true,
    reason: 'pr_approval_required',
    from_phase: 'PUSH',
    to_phase: LOOP_PHASES.PR_APPROVAL_PENDING,
    approval_id: 'APR-PR',
    execution_connected: true,
    commands_executed: ['git push origin HEAD:<approved_branch>'],
    push_allowed: true,
    pr_allowed: false,
    next_action: 'request_pr_approval_then_resume'
  });
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({
    status: STORY_STATUSES.WAITING_APPROVAL,
    current_phase: LOOP_PHASES.PR_APPROVAL_PENDING,
    current_approval_id: 'APR-PR',
    current_commit_sha: 'abc123',
    current_branch: 'feature/wired',
    current_base_branch: 'main'
  });
});

test('resumeApprovalToExecutionPhase resumes PR approval to PR not DONE', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.WAITING_APPROVAL,
    current_phase: LOOP_PHASES.PR_APPROVAL_PENDING,
    current_approval_id: 'APR-PR'
  });

  const result = resumeApprovalToExecutionPhase(readStory(rootDir, 'STORY-WIRED'), {
    rootDir,
    now: new Date('2026-05-12T12:05:00.000Z'),
    approvals: { 'APR-PR': 'approved' }
  });

  expect(result).toMatchObject({
    ok: true,
    from_phase: LOOP_PHASES.PR_APPROVAL_PENDING,
    to_phase: 'PR',
    approval_id: 'APR-PR',
    next_action: 'create_approved_pull_request'
  });
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({
    status: STORY_STATUSES.RUNNING,
    current_phase: 'PR'
  });
});

test('advancePrPhase marks story DONE after approved PR creation succeeds', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.RUNNING,
    current_phase: 'PR',
    current_approval_id: 'APR-PR',
    current_commit_sha: 'abc123',
    current_branch: 'feature/wired',
    repository_full_name: 'milechy/MCA'
  });

  const result = advancePrPhase(readStory(rootDir, 'STORY-WIRED'), {
    rootDir,
    now: new Date('2026-05-12T12:06:00.000Z'),
    pr_runner: () => ({
      ok: true,
      stage: 'opencode_pr',
      approval_id: 'APR-PR',
      commit_sha: 'abc123',
      head_branch: 'feature/wired',
      base_branch: 'main',
      title: 'Wire lifecycle phases',
      pr_url: 'https://github.com/milechy/MCA/pull/99',
      pr_number: 99,
      execution_connected: true,
      pr_allowed: true,
      commands_executed: ['github.createPullRequest'],
      files_modified: [],
      repository_files_modified: [],
      pr_created: true
    })
  });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    from_phase: 'PR',
    to_phase: LOOP_PHASES.DONE,
    pr: { pr_url: 'https://github.com/milechy/MCA/pull/99', pr_number: 99, pr_created: true },
    execution_connected: true,
    commands_executed: ['github.createPullRequest'],
    pr_allowed: true,
    next_action: 'story_complete'
  });
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({
    status: STORY_STATUSES.COMPLETED,
    current_phase: LOOP_PHASES.DONE,
    pr_url: 'https://github.com/milechy/MCA/pull/99',
    pr_number: 99
  });
});

test('tickAutonomousLoopWired escalates ineligible-fallback OPENCODE_RUNNING stuck story after max_attempts', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.RUNNING,
    current_phase: LOOP_PHASES.OPENCODE_RUNNING,
    current_approval_id: 'APR-STUCK',
    current_job_id: 'JOB-STUCK',
    current_sandbox_root: '.ralph/tmp/opencode-sandbox/APR-STUCK',
    requested_paths: ['src/runtime-change-soak.js'],
    max_attempts: 2
  });

  const stuckDispatcher = () => ({
    ok: false,
    stage: 'nemoclaw_opencode_gateway',
    reason: 'nemoclaw_runtime_timeout',
    job_id: 'JOB-STUCK',
    approval_id: 'APR-STUCK',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-STUCK',
    candidate_patch_path: null,
    execution_connected: true,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    opencode_runtime_mode: 'nemoclaw-mediated',
    mediator: 'nemoclaw'
  });

  const firstTick = tickAutonomousLoopWired({
    rootDir,
    story_id: 'STORY-WIRED',
    now: new Date('2026-05-12T12:08:00.000Z'),
    opencode_dispatcher: stuckDispatcher,
    pre_secret_scan_ok: true
  });
  expect(firstTick.to_phase).toBe(LOOP_PHASES.OPENCODE_RUNNING);
  expect(firstTick.attempts).toBe(1);
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({ attempts: 1, current_phase: LOOP_PHASES.OPENCODE_RUNNING });

  const secondTick = tickAutonomousLoopWired({
    rootDir,
    story_id: 'STORY-WIRED',
    now: new Date('2026-05-12T12:09:00.000Z'),
    opencode_dispatcher: stuckDispatcher,
    pre_secret_scan_ok: true
  });
  expect(secondTick).toMatchObject({
    ok: false,
    to_phase: LOOP_PHASES.ESCALATED,
    next_action: 'human_escalation_required'
  });
  expect(readStory(rootDir, 'STORY-WIRED')).toMatchObject({
    attempts: 2,
    current_phase: LOOP_PHASES.ESCALATED,
    status: STORY_STATUSES.FAILED
  });
});

test('tickAutonomousLoopWired uses wrapper approval resume path for push approval', () => {
  const rootDir = tmpRoot();
  seed(rootDir, {
    status: STORY_STATUSES.WAITING_APPROVAL,
    current_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING,
    current_approval_id: 'APR-PUSH'
  });

  const result = tickAutonomousLoopWired({
    rootDir,
    story_id: 'STORY-WIRED',
    now: new Date('2026-05-12T12:07:00.000Z'),
    approvals: { 'APR-PUSH': 'approved' }
  });

  expect(result).toMatchObject({
    ok: true,
    from_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING,
    to_phase: 'PUSH',
    next_action: 'push_approved_commit'
  });
});

const { baseBranchForStory, resetBaseBranchCacheForTests } = require('../../src/ralph/autonomous-loop-wired');

test('baseBranchForStory prefers story.base_branch over env over remote HEAD over main', () => {
  resetBaseBranchCacheForTests();
  // 1. story.base_branch wins
  expect(baseBranchForStory({ base_branch: 'feature/x' }, { RALPH_PR_BASE_BRANCH: 'env-branch' }, { rootDir: '/tmp' })).toBe('feature/x');

  // 2. env wins when story.base_branch is absent
  resetBaseBranchCacheForTests();
  expect(baseBranchForStory({}, { RALPH_PR_BASE_BRANCH: 'env-branch' }, { rootDir: '/tmp' })).toBe('env-branch');

  // 3. remote HEAD detection wins when env is unset
  resetBaseBranchCacheForTests();
  const fakeSpawn = () => ({ status: 0, stdout: 'origin/infra/phase0-autonomous-foundation\n', stderr: '' });
  expect(baseBranchForStory({}, {}, { rootDir: '/tmp', spawn: fakeSpawn })).toBe('infra/phase0-autonomous-foundation');

  // 4. fall back to 'main' only when nothing else resolves
  resetBaseBranchCacheForTests();
  const failingSpawn = () => ({ status: 1, stdout: '', stderr: 'fatal' });
  expect(baseBranchForStory({}, {}, { rootDir: '/tmp', spawn: failingSpawn })).toBe('main');
});

test('baseBranchForStory rejects unsafe ref shapes returned by git', () => {
  resetBaseBranchCacheForTests();
  const evilSpawn = () => ({ status: 0, stdout: 'origin/--upload-pack=evil\n', stderr: '' });
  // Falls back to 'main' since the detected ref name is not a safe branch shape.
  expect(baseBranchForStory({}, {}, { rootDir: '/tmp', spawn: evilSpawn })).toBe('main');
});

const {
  repositoryForStory,
  detectRepositoryFromGitRemote,
  resetRepositoryDetectionCacheForTests
} = require('../../src/ralph/autonomous-loop-wired');

test('detectRepositoryFromGitRemote parses https + ssh git remote urls', () => {
  resetRepositoryDetectionCacheForTests();
  const https = () => ({ status: 0, stdout: 'https://github.com/milechy/MCA.git\n', stderr: '' });
  expect(detectRepositoryFromGitRemote('/tmp', { spawn: https })).toBe('milechy/MCA');

  resetRepositoryDetectionCacheForTests();
  const ssh = () => ({ status: 0, stdout: 'git@github.com:milechy/MCA.git\n', stderr: '' });
  expect(detectRepositoryFromGitRemote('/tmp', { spawn: ssh })).toBe('milechy/MCA');

  resetRepositoryDetectionCacheForTests();
  const noGit = () => ({ status: 0, stdout: 'https://github.com/milechy/MCA\n', stderr: '' });
  expect(detectRepositoryFromGitRemote('/tmp', { spawn: noGit })).toBe('milechy/MCA');
});

test('detectRepositoryFromGitRemote refuses malformed or hostile remote urls', () => {
  resetRepositoryDetectionCacheForTests();
  const evil = () => ({ status: 0, stdout: 'https://github.com/owner/repo; rm -rf /\n', stderr: '' });
  expect(detectRepositoryFromGitRemote('/tmp', { spawn: evil })).toBeNull();

  resetRepositoryDetectionCacheForTests();
  const bad = () => ({ status: 1, stdout: '', stderr: 'fatal: no remote' });
  expect(detectRepositoryFromGitRemote('/tmp', { spawn: bad })).toBeNull();
});

test('repositoryForStory order: arg > story.repository_full_name > github_issue.repository > env.GITHUB_REPOSITORY > git remote', () => {
  resetRepositoryDetectionCacheForTests();
  const detect = () => ({ status: 0, stdout: 'https://github.com/auto/detected.git\n', stderr: '' });

  expect(repositoryForStory({}, {}, 'arg/wins', { rootDir: '/tmp', spawn: detect })).toBe('arg/wins');
  resetRepositoryDetectionCacheForTests();
  expect(repositoryForStory({ repository_full_name: 'story/wins' }, {}, null, { rootDir: '/tmp', spawn: detect })).toBe('story/wins');
  resetRepositoryDetectionCacheForTests();
  expect(repositoryForStory({ github_issue: { repository_full_name: 'issue/wins' } }, {}, null, { rootDir: '/tmp', spawn: detect })).toBe('issue/wins');
  resetRepositoryDetectionCacheForTests();
  expect(repositoryForStory({}, { GITHUB_REPOSITORY: 'env/wins' }, null, { rootDir: '/tmp', spawn: detect })).toBe('env/wins');
  resetRepositoryDetectionCacheForTests();
  expect(repositoryForStory({}, {}, null, { rootDir: '/tmp', spawn: detect })).toBe('auto/detected');
});

test('repositoryForStory filters out malformed candidates regardless of source', () => {
  resetRepositoryDetectionCacheForTests();
  expect(repositoryForStory({}, { GITHUB_REPOSITORY: 'evil; rm -rf /' }, null, { rootDir: '/tmp' })).toBeNull();
});
