const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { approveApprovalRecordOnly, readApproval } = require('../../src/ralph/approval-manager');
const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const { createOpenCodePushApproval, currentHead, currentBranch } = require('../../src/telegram/opencode-push-approval');
const { opencodePushPreflight, pushOpenCodeCommit } = require('../../src/telegram/opencode-push');

function gitCommit(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: rootDir, stdio: 'ignore' });
}

function makeRemoteRepo() {
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-push-remote-'));
  execFileSync('git', ['init', '--bare'], { cwd: remoteDir, stdio: 'ignore' });
  return remoteDir;
}

function makeGitRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-push-'));
  const remoteDir = makeRemoteRepo();
  execFileSync('git', ['init', '-b', 'feature/opencode-push'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.gitignore'), '.ralph/\n');
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  gitCommit(rootDir, 'init');
  execFileSync('git', ['push', '-u', 'origin', 'HEAD:feature/opencode-push'], { cwd: rootDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(rootDir, 'feature.txt'), 'feature\n');
  gitCommit(rootDir, 'add feature');
  return { rootDir, remoteDir };
}

function makeApprovedPushApproval(rootDir) {
  const approval = createOpenCodePushApproval({
    rootDir,
    commit_sha: currentHead(rootDir),
    branch: currentBranch(rootDir),
    remote: 'origin',
    allowed_user_ids: [3],
    now: new Date('2026-05-07T12:34:56.789Z')
  });
  expect(approval.ok).toBe(true);
  approveApprovalRecordOnly(approval.approval_id, 3, { rootDir });
  return readApproval(rootDir, approval.approval_id);
}

test('parseTelegramCommand parses /opencode-push', () => {
  const parsed = parseTelegramCommand('/opencode-push APR-1');
  expect(parsed.type).toBe('opencode_push');
  expect(parsed.args).toEqual(['APR-1']);
});

test('opencodePushPreflight passes only for approved push approval', () => {
  const { rootDir } = makeGitRepo();
  const approval = makeApprovedPushApproval(rootDir);
  const result = opencodePushPreflight({ rootDir, approval_id: approval.approval_id });
  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_push_preflight',
    reason: null,
    approval_id: approval.approval_id,
    commit_sha: approval.commit_sha,
    branch: approval.branch,
    remote: 'origin',
    command: 'git push',
    execution_connected: false,
    push_allowed: true,
    commands_executed: [],
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'push_commit_to_origin_branch'
  });
});

test('pushOpenCodeCommit pushes approved HEAD without deploy or migration', () => {
  const { rootDir, remoteDir } = makeGitRepo();
  const approval = makeApprovedPushApproval(rootDir);
  const times = [new Date('2026-05-07T00:00:00.000Z'), new Date('2026-05-07T00:00:00.120Z')];
  const result = pushOpenCodeCommit({
    rootDir,
    approval_id: approval.approval_id,
    now: () => times.shift() || new Date('2026-05-07T00:00:00.120Z')
  });
  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_push',
    reason: null,
    approval_id: approval.approval_id,
    commit_sha: approval.commit_sha,
    branch: approval.branch,
    remote: 'origin',
    command: 'git push',
    exit_code: 0,
    started_at: '2026-05-07T00:00:00.000Z',
    finished_at: '2026-05-07T00:00:00.120Z',
    duration_ms: 120,
    execution_connected: true,
    push_allowed: true,
    commands_executed: ['git push origin HEAD:<approved_branch>'],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: true,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'open_pull_request_or_continue_operator_review'
  });
  const remoteHead = execFileSync('git', ['--git-dir', remoteDir, 'rev-parse', 'refs/heads/feature/opencode-push'], { encoding: 'utf8' }).trim();
  expect(remoteHead).toBe(approval.commit_sha);
});

test('pushOpenCodeCommit blocks unapproved approval before execution', () => {
  const { rootDir } = makeGitRepo();
  const approval = makeApprovedPushApproval(rootDir);
  const pending = { ...approval, approval_id: 'APR-PUSH-PENDING', status: 'pending' };
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${pending.approval_id}.json`), `${JSON.stringify(pending, null, 2)}\n`);
  const result = pushOpenCodeCommit({ rootDir, approval_id: pending.approval_id });
  expect(result).toMatchObject({
    ok: false,
    stage: 'opencode_push',
    reason: 'approval_not_approved',
    execution_connected: false,
    push_allowed: false,
    commands_executed: [],
    push_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('/opencode-push handler pushes approved commit and reports bounded summary', () => {
  const { rootDir } = makeGitRepo();
  const approval = makeApprovedPushApproval(rootDir);
  const result = handleTelegramCommand(parseTelegramCommand(`/opencode-push ${approval.approval_id}`), {
    rootDir,
    user_id: 3,
    roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
  });
  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(true);
  expect(result.push_allowed).toBe(true);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.push_performed).toBe(true);
  expect(result.summary.deploy_performed).toBe(false);
  expect(result.summary.migration_performed).toBe(false);
  expect(result.text).toContain('OpenCode push completed. Deploy remains disabled.');
});
