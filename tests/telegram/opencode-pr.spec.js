const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { approveApprovalRecordOnly, readApproval } = require('../../src/ralph/approval-manager');
const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { createOpenCodePrApproval } = require('../../src/telegram/opencode-pr-approval');
const { currentHead, currentBranch } = require('../../src/telegram/opencode-push-approval');
const { opencodePrPreflight, createOpenCodePullRequest, buildFallbackPrBodyFromApproval } = require('../../src/telegram/opencode-pr');

function gitCommit(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: rootDir, stdio: 'ignore' });
}

function makeGitRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pr-'));
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

function makeApprovedPrApproval(rootDir, overrides = {}) {
  const result = createOpenCodePrApproval({
    rootDir,
    commit_sha: currentHead(rootDir),
    head_branch: currentBranch(rootDir),
    base_branch: 'main',
    title: 'Add feature from OpenCode',
    body: overrides.body === undefined ? 'Controlled PR body' : overrides.body,
    allowed_user_ids: [3],
    now: new Date('2026-05-07T12:34:56.789Z')
  });
  expect(result.ok).toBe(true);
  approveApprovalRecordOnly(result.approval_id, 3, { rootDir });
  const approval = readApproval(rootDir, result.approval_id);
  const patched = { ...approval, ...overrides };
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${approval.approval_id}.json`), `${JSON.stringify(patched, null, 2)}\n`);
  return readApproval(rootDir, result.approval_id);
}

test('parseTelegramCommand parses /opencode-pr', () => {
  const parsed = parseTelegramCommand('/opencode-pr APR-1');
  expect(parsed.type).toBe('opencode_pr');
  expect(parsed.args).toEqual(['APR-1']);
});

test('opencodePrPreflight passes only for approved PR approval', () => {
  const rootDir = makeGitRepo();
  const approval = makeApprovedPrApproval(rootDir);
  const result = opencodePrPreflight({ rootDir, approval_id: approval.approval_id });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_pr_preflight',
    reason: null,
    approval_id: approval.approval_id,
    commit_sha: approval.commit_sha,
    head_branch: 'feature/opencode-pr',
    base_branch: 'main',
    title: 'Add feature from OpenCode',
    execution_connected: false,
    pr_allowed: true,
    commands_executed: [],
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'create_github_pull_request'
  });
});

test('createOpenCodePullRequest creates PR through bounded client without merge deploy or migration', () => {
  const rootDir = makeGitRepo();
  const approval = makeApprovedPrApproval(rootDir);
  const calls = [];
  const fakeClient = {
    createPullRequest(input) {
      calls.push(input);
      return { ok: true, number: 42, url: 'https://github.com/example/repo/pull/42' };
    }
  };
  const times = [new Date('2026-05-07T00:00:00.000Z'), new Date('2026-05-07T00:00:00.050Z')];
  const result = createOpenCodePullRequest({
    rootDir,
    approval_id: approval.approval_id,
    githubClient: fakeClient,
    repository_full_name: 'example/repo',
    now: () => times.shift() || new Date('2026-05-07T00:00:00.050Z')
  });

  expect(calls).toEqual([{ repository_full_name: 'example/repo', title: 'Add feature from OpenCode', body: 'Controlled PR body', head: 'feature/opencode-pr', base: 'main' }]);
  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_pr',
    reason: null,
    approval_id: approval.approval_id,
    commit_sha: approval.commit_sha,
    head_branch: 'feature/opencode-pr',
    base_branch: 'main',
    title: 'Add feature from OpenCode',
    pr_url: 'https://github.com/example/repo/pull/42',
    pr_number: 42,
    started_at: '2026-05-07T00:00:00.000Z',
    finished_at: '2026-05-07T00:00:00.050Z',
    duration_ms: 50,
    execution_connected: true,
    pr_allowed: true,
    commands_executed: ['github.createPullRequest'],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: true,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    pr_body_generated: false,
    next_action: 'review_pull_request'
  });
});

test('createOpenCodePullRequest generates fallback PR body when approval body is empty', () => {
  const rootDir = makeGitRepo();
  const approval = makeApprovedPrApproval(rootDir, {
    body: '',
    story_id: 'STORY-GH-20',
    plan_summary: 'Generate a bounded PR body.',
    plan_hash: 'sha256:planhash',
    pre_exec_diff_hash: 'sha256:diffhash',
    changed_files: ['src/ralph/pr-body-generator.js'],
    gates: { ok: true, gates: [{ id: 'ralph-tests', ok: true }] },
    github_issue: { issue_number: 20, url: 'https://github.com/milechy/MCA/issues/20' }
  });
  const calls = [];
  const fakeClient = {
    createPullRequest(input) {
      calls.push(input);
      return { ok: true, number: 43, url: 'https://github.com/example/repo/pull/43' };
    }
  };

  const result = createOpenCodePullRequest({ rootDir, approval_id: approval.approval_id, githubClient: fakeClient, repository_full_name: 'example/repo' });

  expect(result).toMatchObject({
    ok: true,
    pr_body_generated: true,
    pr_body_generator: {
      ok: true,
      stage: 'pr_body_generator',
      bounded_output: true,
      raw_logs_included: false,
      secrets_included: false
    },
    pr_created: true,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toContain('## Summary');
  expect(calls[0].body).toContain('STORY-GH-20');
  expect(calls[0].body).toContain('GitHub issue: #20');
  expect(calls[0].body).toContain('No raw logs or secrets included');
});

test('buildFallbackPrBodyFromApproval redacts approval metadata', () => {
  const tokenFixture = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz'].join('');
  const result = buildFallbackPrBodyFromApproval({
    story_id: 'STORY-SECRET',
    title: `Do not leak ${tokenFixture}`,
    plan_summary: `password: hunter2 token=${tokenFixture}`,
    plan_hash: tokenFixture,
    pre_exec_diff_hash: `secret=${tokenFixture}`,
    changed_files: [`src/${tokenFixture}.js`],
    status: 'approved',
    approval_id: `APR-${tokenFixture}`,
    requested_action: 'opencode_create_pr'
  });
  expect(result.body).not.toContain(tokenFixture);
  expect(result.body).not.toContain('hunter2');
});

test('createOpenCodePullRequest blocks unapproved approval before client call', () => {
  const rootDir = makeGitRepo();
  const approval = makeApprovedPrApproval(rootDir);
  const pending = { ...approval, approval_id: 'APR-PR-PENDING', status: 'pending' };
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${pending.approval_id}.json`), `${JSON.stringify(pending, null, 2)}\n`);
  let called = false;
  const result = createOpenCodePullRequest({
    rootDir,
    approval_id: pending.approval_id,
    githubClient: { createPullRequest() { called = true; return { ok: true }; } },
    repository_full_name: 'example/repo'
  });
  expect(called).toBe(false);
  expect(result).toMatchObject({
    ok: false,
    stage: 'opencode_pr',
    reason: 'approval_not_approved',
    execution_connected: false,
    pr_allowed: false,
    commands_executed: [],
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
});

test('createOpenCodePullRequest blocks missing GitHub client', () => {
  const rootDir = makeGitRepo();
  const approval = makeApprovedPrApproval(rootDir);
  const result = createOpenCodePullRequest({ rootDir, approval_id: approval.approval_id, repository_full_name: 'example/repo' });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('github_client_required');
  expect(result.pr_created).toBe(false);
  expect(result.merge_performed).toBe(false);
});
