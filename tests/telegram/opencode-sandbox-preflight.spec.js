const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { handleTelegramCommand } = require('../../src/telegram/handlers');
const {
  OPENCODE_SANDBOX_ENV,
  opencodeSandboxEnabled,
  parseGitStatusPorcelain,
  isRalphRuntimeStatePath,
  workingTreeClean,
  branchAllowed,
  isForbiddenRequestedPath,
  isAllowedRequestedPath,
  classifyRequestedPaths,
  opencodeSandboxRunnerPreflight
} = require('../../src/telegram/opencode-sandbox-preflight');

function gitCommit(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: rootDir, stdio: 'ignore' });
}

function makeGitRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sandbox-preflight-'));
  execFileSync('git', ['init', '-b', 'feature/opencode-sandbox'], { cwd: rootDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'approval-pending'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph', 'tmp', 'opencode-sandbox'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# test\n');
  gitCommit(rootDir, 'init');
  return rootDir;
}

function writeApproval(rootDir, approvalId, overrides = {}) {
  const approval = {
    approval_id: approvalId,
    approval_type: 'plan',
    status: 'approved',
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides
  };
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-pending', `${approvalId}.json`), JSON.stringify(approval, null, 2));
  gitCommit(rootDir, `approval ${approvalId}`);
  return approval;
}

test('parseTelegramCommand parses /opencode-sandbox-preflight', () => {
  const parsed = parseTelegramCommand('/opencode-sandbox-preflight APR-ONE .ralph/tmp/opencode-sandbox/APR-ONE src/foo.js tests/foo.spec.js');
  expect(parsed.type).toBe('opencode_sandbox_preflight');
  expect(parsed.args).toEqual(['APR-ONE', '.ralph/tmp/opencode-sandbox/APR-ONE', 'src/foo.js', 'tests/foo.spec.js']);
});

test('OpenCode sandbox env gate is explicit true only', () => {
  expect(opencodeSandboxEnabled({})).toBe(false);
  expect(opencodeSandboxEnabled({ [OPENCODE_SANDBOX_ENV]: '1' })).toBe(false);
  expect(opencodeSandboxEnabled({ [OPENCODE_SANDBOX_ENV]: 'true' })).toBe(true);
});

test('branch and requested path classification are fail-closed', () => {
  expect(branchAllowed('feature/test')).toBe(true);
  expect(branchAllowed('main')).toBe(false);
  expect(branchAllowed('master')).toBe(false);
  expect(branchAllowed(null)).toBe(false);

  expect(isAllowedRequestedPath('src/foo.js')).toBe(true);
  expect(isAllowedRequestedPath('tests/foo.spec.js')).toBe(true);
  expect(isForbiddenRequestedPath('.env')).toBe(true);
  expect(isForbiddenRequestedPath('../secret')).toBe(true);
  expect(isForbiddenRequestedPath('/tmp/secret')).toBe(true);

  const classified = classifyRequestedPaths(['src/foo.js', '.env', 'private/data.txt']);
  expect(classified.requested).toEqual(['src/foo.js', '.env', 'private/data.txt']);
  expect(classified.blocked).toEqual(['.env', 'private/data.txt']);
});

test('Ralph runtime state is ignored for preflight cleanliness but repository changes still block', () => {
  const rootDir = makeGitRepo();
  fs.mkdirSync(path.join(rootDir, '.ralph', 'stories'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'stories', 'STORY-GH-27.json'), '{}\n');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '{"event":"approval"}\n');
  fs.mkdirSync(path.join(rootDir, '.ralph', 'external-agent-jobs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'external-agent-jobs', 'JOB-OPENCODE-AUTO-GH-27.json'), '{}\n');
  fs.mkdirSync(path.join(rootDir, '.ralph', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'logs', 'audit.jsonl'), '{"event":"audit"}\n');

  expect(parseGitStatusPorcelain('?? .ralph/stories/\n M README.md')).toEqual([
    { status: '??', path: '.ralph/stories/' },
    { status: ' M', path: 'README.md' }
  ]);
  expect(isRalphRuntimeStatePath('.ralph/stories/STORY-GH-27.json')).toBe(true);
  expect(isRalphRuntimeStatePath('.ralph/approval-log.jsonl')).toBe(true);
  expect(isRalphRuntimeStatePath('.ralph/external-agent-jobs/JOB-OPENCODE-AUTO-GH-27.json')).toBe(true);
  expect(isRalphRuntimeStatePath('README.md')).toBe(false);
  expect(workingTreeClean(rootDir)).toBe(true);

  fs.writeFileSync(path.join(rootDir, 'README.md'), '# changed\n');
  expect(workingTreeClean(rootDir)).toBe(false);
});

test('OpenCode sandbox runner preflight ignores Ralph runtime state entries', () => {
  const rootDir = makeGitRepo();
  const approvalId = 'APR-OPENCODE-SANDBOX-RUNTIME';
  writeApproval(rootDir, approvalId);
  fs.mkdirSync(path.join(rootDir, '.ralph', 'stories'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'stories', 'STORY-GH-27.json'), '{}\n');
  fs.mkdirSync(path.join(rootDir, '.ralph', 'external-agent-jobs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph', 'external-agent-jobs', 'JOB-OPENCODE-AUTO-GH-27.json'), '{}\n');
  fs.writeFileSync(path.join(rootDir, '.ralph', 'approval-log.jsonl'), '{"event":"approval"}\n');

  const result = opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: approvalId,
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    requested_paths: ['src/foo.js'],
    pre_secret_scan_ok: true,
    env: { [OPENCODE_SANDBOX_ENV]: 'true' },
    now: new Date('2026-05-07T00:00:00.000Z')
  });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    working_tree_clean: true,
    dirty_entries: [],
    ignored_runtime_state_entries: expect.arrayContaining(['.ralph/approval-log.jsonl', '.ralph/stories/STORY-GH-27.json', '.ralph/external-agent-jobs/JOB-OPENCODE-AUTO-GH-27.json'])
  });
});

test('OpenCode sandbox runner preflight still blocks real repository changes', () => {
  const rootDir = makeGitRepo();
  const approvalId = 'APR-OPENCODE-SANDBOX-DIRTY';
  writeApproval(rootDir, approvalId);
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# dirty\n');

  const result = opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: approvalId,
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    requested_paths: ['README.md'],
    pre_secret_scan_ok: true,
    env: { [OPENCODE_SANDBOX_ENV]: 'true' },
    now: new Date('2026-05-07T00:00:00.000Z')
  });

  expect(result).toMatchObject({
    ok: false,
    reason: 'working_tree_dirty',
    working_tree_clean: false,
    dirty_entries: ['README.md']
  });
});

test('OpenCode sandbox runner preflight with worktree_isolated=true downgrades working_tree_dirty to informational', () => {
  // Phase 1 #8 Bug E fix: when the dispatcher creates a per-story detached
  // worktree (opencode-kimi-direct), the real repository's working tree
  // cannot affect the dispatched run. The preflight must surface the dirty
  // state for diagnostics but not block dispatch.
  const rootDir = makeGitRepo();
  const approvalId = 'APR-OPENCODE-SANDBOX-DIRTY-WORKTREE';
  writeApproval(rootDir, approvalId);
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# applied by another in-flight story\n');

  const result = opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: approvalId,
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    requested_paths: ['docs/soak/my-story.md'],
    pre_secret_scan_ok: true,
    env: { [OPENCODE_SANDBOX_ENV]: 'true' },
    now: new Date('2026-05-07T00:00:00.000Z'),
    worktree_isolated: true
  });

  // dirty state is reported but does NOT block dispatch
  expect(result.working_tree_clean).toBe(false);
  expect(result.dirty_entries).toContain('README.md');
  expect(result.reason).not.toBe('working_tree_dirty');
  expect(result.ok).toBe(true);
});

test('OpenCode sandbox runner preflight with worktree_isolated=true still blocks other hard failures', () => {
  // The downgrade is narrow: only working_tree_dirty is downgraded. All other
  // preflight failure reasons (approval expired, sandbox_root_not_allowed,
  // pre_secret_scan_failed, etc.) still block dispatch regardless of
  // worktree_isolated.
  const rootDir = makeGitRepo();
  // No approval written -> approval_id_required should fire even with
  // worktree_isolated=true. (The opencode-sandbox-preflight checks approval
  // existence after sandbox_root validation; we exercise the principle.)
  const result = opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: 'APR-DOES-NOT-EXIST',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-DOES-NOT-EXIST',
    requested_paths: ['docs/x.md'],
    pre_secret_scan_ok: true,
    env: { [OPENCODE_SANDBOX_ENV]: 'true' },
    now: new Date('2026-05-07T00:00:00.000Z'),
    worktree_isolated: true
  });
  expect(result.ok).toBe(false);
  // Reason should NOT be working_tree_dirty; it should be a real
  // approval-related failure.
  expect(result.reason).not.toBe('working_tree_dirty');
});

test('OpenCode sandbox runner preflight passes only as metadata and does not execute', () => {
  const rootDir = makeGitRepo();
  const approvalId = 'APR-OPENCODE-SANDBOX-1';
  writeApproval(rootDir, approvalId);

  const result = opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: approvalId,
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    requested_paths: ['src/foo.js', 'tests/foo.spec.js'],
    pre_secret_scan_ok: true,
    env: { [OPENCODE_SANDBOX_ENV]: 'true' },
    now: new Date('2026-05-07T00:00:00.000Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_sandbox_runner_preflight',
    reason: null,
    start_allowed: true,
    approval_id: approvalId,
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    branch: 'feature/opencode-sandbox',
    working_tree_clean: true,
    opencode_sandbox_enabled: true,
    requested_paths: ['src/foo.js', 'tests/foo.spec.js'],
    blocked_paths: [],
    pre_secret_scan_ok: true,
    execution_connected: false,
    opencode_execution_started: false,
    commands_executed: [],
    files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'phase12_6_sandbox_execution_can_be_considered'
  });
});

test('OpenCode sandbox runner preflight blocks missing env gate and forbidden paths', () => {
  const rootDir = makeGitRepo();
  const approvalId = 'APR-OPENCODE-SANDBOX-2';
  writeApproval(rootDir, approvalId);

  const noEnv = opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: approvalId,
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    requested_paths: ['src/foo.js'],
    pre_secret_scan_ok: true,
    env: {},
    now: new Date('2026-05-07T00:00:00.000Z')
  });
  expect(noEnv.ok).toBe(false);
  expect(noEnv.reason).toBe('opencode_sandbox_env_not_enabled');
  expect(noEnv.execution_connected).toBe(false);
  expect(noEnv.opencode_execution_started).toBe(false);

  const forbidden = opencodeSandboxRunnerPreflight({
    rootDir,
    approval_id: approvalId,
    sandbox_root: `.ralph/tmp/opencode-sandbox/${approvalId}`,
    requested_paths: ['.env'],
    pre_secret_scan_ok: true,
    env: { [OPENCODE_SANDBOX_ENV]: 'true' },
    now: new Date('2026-05-07T00:00:00.000Z')
  });
  expect(forbidden.ok).toBe(false);
  expect(forbidden.reason).toBe('requested_path_forbidden');
  expect(forbidden.blocked_paths).toEqual(['.env']);
});

test('/opencode-sandbox-preflight handler returns bounded non-execution result', () => {
  const rootDir = makeGitRepo();
  const approvalId = 'APR-OPENCODE-SANDBOX-3';
  writeApproval(rootDir, approvalId);

  const result = handleTelegramCommand(
    parseTelegramCommand(`/opencode-sandbox-preflight ${approvalId} .ralph/tmp/opencode-sandbox/${approvalId} src/foo.js tests/foo.spec.js`),
    {
      rootDir,
      user_id: 3,
      pre_secret_scan_ok: true,
      env: { [OPENCODE_SANDBOX_ENV]: 'true' },
      now: new Date('2026-05-07T00:00:00.000Z'),
      roles: { owner_user_ids: [1], admin_user_ids: [2], reviewer_user_ids: [3], observer_user_ids: [4] }
    }
  );

  expect(result.ok).toBe(true);
  expect(result.wired_to_runtime).toBe(false);
  expect(result.execution_connected).toBe(false);
  expect(result.opencode_execution_started).toBe(false);
  expect(result.summary.ok).toBe(true);
  expect(result.summary.start_allowed).toBe(true);
  expect(result.summary.commands_executed).toEqual([]);
  expect(result.summary.files_modified).toEqual([]);
  expect(result.text).toContain('OpenCode sandbox runner preflight passed. Execution still not started.');
});
