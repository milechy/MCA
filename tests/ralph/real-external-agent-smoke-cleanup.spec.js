const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  cleanupSmokeRuntime,
  safeRemoveRuntimePath,
  runRealExternalAgentSmoke
} = require('../../scripts/ralph/real-external-agent-smoke');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-real-smoke-cleanup-'));
}

function initGit(rootDir) {
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: rootDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(rootDir, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: rootDir, stdio: 'ignore' });
}

test('safeRemoveRuntimePath only removes allowed smoke runtime paths', () => {
  const rootDir = tmpRoot();
  fs.mkdirSync(path.join(rootDir, '.ralph/external-agent-jobs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph/external-agent-jobs/JOB-1.json'), '{}\n', 'utf8');

  expect(safeRemoveRuntimePath(rootDir, '.ralph/external-agent-jobs/JOB-1.json')).toMatchObject({
    ok: true,
    path: '.ralph/external-agent-jobs/JOB-1.json',
    removed: true
  });
  expect(fs.existsSync(path.join(rootDir, '.ralph/external-agent-jobs/JOB-1.json'))).toBe(false);
  expect(safeRemoveRuntimePath(rootDir, '.ralph/stories/STORY.json')).toMatchObject({
    ok: false,
    reason: 'not_real_external_agent_smoke_runtime_path'
  });
});

test('cleanupSmokeRuntime removes targeted job and sandbox artifacts', () => {
  const rootDir = tmpRoot();
  fs.mkdirSync(path.join(rootDir, '.ralph/external-agent-jobs'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.ralph/tmp/external-agent-smoke/APR-1'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.ralph/external-agent-jobs/JOB-1.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.ralph/tmp/external-agent-smoke/APR-1/candidate.patch'), 'patch\n', 'utf8');

  const result = cleanupSmokeRuntime(rootDir, {
    jobId: 'JOB-1',
    sandboxRoot: '.ralph/tmp/external-agent-smoke/APR-1'
  });

  expect(result).toMatchObject({ kept: false });
  expect(result.removed).toEqual(expect.arrayContaining([
    '.ralph/external-agent-jobs/JOB-1.json',
    '.ralph/tmp/external-agent-smoke/APR-1'
  ]));
  expect(fs.existsSync(path.join(rootDir, '.ralph/external-agent-jobs/JOB-1.json'))).toBe(false);
  expect(fs.existsSync(path.join(rootDir, '.ralph/tmp/external-agent-smoke/APR-1'))).toBe(false);
});

test('explicit runtime approval gate fails safely with clean tree and no live execution', () => {
  const rootDir = tmpRoot();
  initGit(rootDir);

  const result = runRealExternalAgentSmoke({
    rootDir,
    gateway_type: 'nemoclaw',
    command: 'node',
    explicit_runtime_approval: false,
    now: () => new Date('2026-05-12T02:00:00.000Z')
  });

  expect(result).toMatchObject({
    ok: false,
    reason: 'explicit_runtime_approval_required',
    runtime_installed: true,
    execution_connected: false,
    real_gateway_process_started: false,
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    working_tree_clean_after: true
  });
});
