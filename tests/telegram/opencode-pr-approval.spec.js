const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const { createOpenCodePrApproval, defaultPrApprovalId, branchExists } = require('../../src/telegram/opencode-pr-approval');
const { currentHead, currentBranch } = require('../../src/telegram/opencode-push-approval');

function gitCommit(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: rootDir, stdio: 'ignore' });
}

function makeGitRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pr-approval-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.gitignore'), '.ralph/\n');
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  gitCommit(rootDir, 'init');
  execFileSync('git', ['checkout', '-b', 'feature/opencode-pr'], { cwd: rootDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(rootDir, 'feature.txt'), 'feature\n');
  gitCommit(rootDir, 'add feature');
  return rootDir;
}

test('defaultPrApprovalId is deterministic', () => {
  expect(defaultPrApprovalId(new Date('2026-05-07T12:34:56.789Z'))).toBe('APR-OPENCODE-PR-20260507123456');
});

test('parseTelegramCommand parses /opencode-pr-approval', () => {
  const parsed = parseTelegramCommand('/opencode-pr-approval abc123 feature/opencode-pr main Add PR title');
  expect(parsed.type).toBe('opencode_pr_approval');
  expect(parsed.args).toEqual(['abc123', 'feature/opencode-pr', 'main', 'Add', 'PR', 'title']);
});

test('createOpenCodePrApproval creates pending PR approval without creating PR', () => {
  const rootDir = makeGitRepo();
  const head = currentHead(rootDir);
  const branch = currentBranch(rootDir);
  const result = createOpenCodePrApproval({
    rootDir,
    commit_sha: head,
    head_branch: branch,
    base_branch: 'main',
    title: 'Add feature from OpenCode',
    allowed_user_ids: [3],
    now: new Date('2026-05-07T12:34:56.789Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_pr_approval',
    reason: null,
    approval_id: 'APR-OPENCODE-PR-20260507123456',
    commit_sha: head,
    head_branch: branch,
    base_branch: 'main',
    title: 'Add feature from OpenCode',
    pr_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'approve_or_deny_pr_before_github_pr_creation'
  });
  expect(result.approval.status).toBe('pending');
  expect(result.approval.requested_action).toBe('opencode_create_pr');
});

test('createOpenCodePrApproval blocks unsafe or stale PR approval inputs', () => {
  const rootDir = makeGitRepo();
  const head = currentHead(rootDir);
  const branch = currentBranch(rootDir);

  expect(createOpenCodePrApproval({ rootDir, head_branch: branch, base_branch: 'main' }).reason).toBe('commit_sha_required');
  expect(createOpenCodePrApproval({ rootDir, commit_sha: 'bad', head_branch: branch, base_branch: 'main' }).reason).toBe('commit_sha_not_head');
  expect(createOpenCodePrApproval({ rootDir, commit_sha: head, head_branch: 'other', base_branch: 'main' }).reason).toBe('head_branch_not_current');
  expect(createOpenCodePrApproval({ rootDir, commit_sha: head, head_branch: branch, base_branch: branch }).reason).toBe('base_branch_matches_head');
  expect(createOpenCodePrApproval({ rootDir, commit_sha: head, head_branch: branch, base_branch: 'missing' }).reason).toBe('base_branch_not_found');
  fs.writeFileSync(path.join(rootDir, 'dirty.txt'), 'dirty\n');
  expect(createOpenCodePrApproval({ rootDir, commit_sha: head, head_branch: branch, base_branch: 'main' }).reason).toBe('working_tree_dirty');
});

test('/opencode-pr-approval handler returns pending approval summary', () => {
  const rootDir = makeGitRepo();
  const head = currentHead(rootDir);
  const branch = currentBranch(rootDir);
  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-pr-approval ${head} ${branch} main Add feature from OpenCode`), {
    rootDir,
    user_id: 3,
    now: new Date('2026-05-07T12:34:56.789Z'),
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.pr_allowed).toBe(false);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.approval_id).toBe('APR-OPENCODE-PR-20260507123456');
  expect(result.summary.pr_created).toBe(false);
  expect(result.text).toContain('OpenCode PR approval requested. PR creation remains disabled until approval.');
});

test('branchExists checks local refs only', () => {
  const rootDir = makeGitRepo();
  expect(branchExists(rootDir, 'main')).toBe(true);
  expect(branchExists(rootDir, 'missing')).toBe(false);
});
