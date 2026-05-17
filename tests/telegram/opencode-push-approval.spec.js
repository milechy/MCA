const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const { createOpenCodePushApproval, defaultPushApprovalId, currentHead, currentBranch, gitStatusShort } = require('../../src/telegram/opencode-push-approval');

function gitCommit(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: rootDir, stdio: 'ignore' });
}

function makeGitRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-push-approval-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-push'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.gitignore'), '.ralph/\n');
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  gitCommit(rootDir, 'init');
  fs.writeFileSync(path.join(rootDir, 'feature.txt'), 'feature\n');
  gitCommit(rootDir, 'add feature');
  return rootDir;
}

test('defaultPushApprovalId is deterministic', () => {
  expect(defaultPushApprovalId(new Date('2026-05-07T12:34:56.789Z'))).toBe('APR-OPENCODE-PUSH-20260507123456');
});

test('parseTelegramCommand parses /opencode-push-approval', () => {
  const parsed = parseTelegramCommand('/opencode-push-approval abc123 feature/opencode-push origin');
  expect(parsed.type).toBe('opencode_push_approval');
  expect(parsed.args).toEqual(['abc123', 'feature/opencode-push', 'origin']);
});

test('createOpenCodePushApproval creates pending push approval without pushing', () => {
  const rootDir = makeGitRepo();
  const head = currentHead(rootDir);
  const branch = currentBranch(rootDir);
  const result = createOpenCodePushApproval({
    rootDir,
    commit_sha: head,
    branch,
    remote: 'origin',
    allowed_user_ids: [3],
    now: new Date('2026-05-07T12:34:56.789Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_push_approval',
    reason: null,
    approval_id: 'APR-OPENCODE-PUSH-20260507123456',
    commit_sha: head,
    branch,
    remote: 'origin',
    push_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'approve_or_deny_push_before_git_push'
  });
  expect(result.approval.status).toBe('pending');
  expect(result.approval.requested_action).toBe('opencode_commit_push');
});

test('createOpenCodePushApproval blocks unsafe or stale push approval inputs', () => {
  const rootDir = makeGitRepo();
  const head = currentHead(rootDir);
  const branch = currentBranch(rootDir);

  expect(createOpenCodePushApproval({ rootDir, branch, remote: 'origin' }).reason).toBe('commit_sha_required');
  // Phase 1 #13: commit_sha is validated against the BRANCH's tip, not HEAD.
  // A non-matching sha → commit_sha_not_branch_tip; a non-existent branch → branch_not_found.
  expect(createOpenCodePushApproval({ rootDir, commit_sha: '0000000000000000000000000000000000000000', branch, remote: 'origin' }).reason).toBe('commit_sha_not_branch_tip');
  expect(createOpenCodePushApproval({ rootDir, commit_sha: head, branch: 'no-such-branch-anywhere', remote: 'origin' }).reason).toBe('branch_not_found');
  expect(createOpenCodePushApproval({ rootDir, commit_sha: head, branch, remote: 'upstream' }).reason).toBe('remote_not_allowed');
  fs.writeFileSync(path.join(rootDir, 'dirty.txt'), 'dirty\n');
  expect(createOpenCodePushApproval({ rootDir, commit_sha: head, branch, remote: 'origin' }).reason).toBe('working_tree_dirty');
});

test('/opencode-push-approval handler returns pending approval summary', () => {
  const rootDir = makeGitRepo();
  const head = currentHead(rootDir);
  const branch = currentBranch(rootDir);
  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-push-approval ${head} ${branch} origin`), {
    rootDir,
    user_id: 3,
    now: new Date('2026-05-07T12:34:56.789Z'),
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.push_allowed).toBe(false);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.approval_id).toBe('APR-OPENCODE-PUSH-20260507123456');
  expect(result.summary.push_performed).toBe(false);
  expect(result.text).toContain('OpenCode push approval requested. Push remains disabled until approval.');
});

test('git helpers return compact repository state', () => {
  const rootDir = makeGitRepo();
  expect(currentHead(rootDir)).toMatch(/^[a-f0-9]{40}$/);
  expect(currentBranch(rootDir)).toBe('feature/opencode-push');
  expect(gitStatusShort(rootDir)).toBe('');
});

test('Phase 1 #10: createOpenCodePushApproval ignores .ralph/ runtime state when checking working tree', () => {
  // The push approval must not be blocked by Ralph's own runtime state
  // (story queue, approval-pending files, tmp dirs). Bug G regression guard.
  const rootDir = makeGitRepo();
  const head = currentHead(rootDir);
  const branch = currentBranch(rootDir);

  fs.mkdirSync(path.join(rootDir, '.ralph', 'stories'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'stories', 'STORY-X.json'), '{}\n');
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'tmp', 'scratch.txt'), 'tmp\n');

  const result = createOpenCodePushApproval({ rootDir, commit_sha: head, branch, remote: 'origin' });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe(null);
});

test('Phase 1 #10: createOpenCodePushApproval with worktree_isolated=true downgrades a dirty main working tree to informational', () => {
  // Bug G core fix: when the autonomous-loop dispatcher uses per-story
  // git-worktree isolation, an incidentally dirty main working tree (from
  // a concurrent story mid-APPLY) must not escalate our push approval.
  const rootDir = makeGitRepo();
  const head = currentHead(rootDir);
  const branch = currentBranch(rootDir);

  // Simulate a parallel story's mid-APPLY state outside .ralph/
  fs.writeFileSync(path.join(rootDir, 'parallel-story-applied.md'), 'mid-apply\n');

  // Without worktree_isolated: blocks (back-compat with non-isolated callers).
  expect(createOpenCodePushApproval({ rootDir, commit_sha: head, branch, remote: 'origin' }).reason).toBe('working_tree_dirty');

  // With worktree_isolated=true: passes.
  const result = createOpenCodePushApproval({ rootDir, commit_sha: head, branch, remote: 'origin', worktree_isolated: true });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe(null);
});
