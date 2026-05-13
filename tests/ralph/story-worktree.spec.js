const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  isAllowedSandboxRoot,
  worktreePathFor,
  createStoryWorktree,
  destroyStoryWorktree,
  diffStoryWorktree
} = require('../../src/ralph/story-worktree');

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-worktree-repo-'));
  function git(args) {
    return spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  }
  expect(git(['init', '-q', '-b', 'main']).status).toBe(0);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
  expect(git(['add', '.']).status).toBe(0);
  expect(git(['commit', '-q', '-m', 'initial']).status).toBe(0);
  return repo;
}

test('isAllowedSandboxRoot accepts .ralph/sandboxes and .ralph/tmp prefixes only', () => {
  expect(isAllowedSandboxRoot('.ralph/sandboxes/STORY-1')).toBe('.ralph/sandboxes/STORY-1');
  expect(isAllowedSandboxRoot('.ralph/tmp/opencode-sandbox/APR-1')).toBe('.ralph/tmp/opencode-sandbox/APR-1');
  expect(isAllowedSandboxRoot('tmp/elsewhere')).toBeNull();
  expect(isAllowedSandboxRoot('../escape')).toBeNull();
  expect(isAllowedSandboxRoot('/abs')).toBeNull();
  expect(isAllowedSandboxRoot('')).toBeNull();
});

test('worktreePathFor places worktree dir inside sandbox_root', () => {
  const rootDir = '/repo';
  const paths = worktreePathFor(rootDir, '.ralph/sandboxes/STORY-X');
  expect(paths).toEqual({
    relative: '.ralph/sandboxes/STORY-X/worktree',
    absolute: path.resolve(rootDir, '.ralph/sandboxes/STORY-X/worktree')
  });
});

test('createStoryWorktree refuses traversal or non-allowed sandbox roots', () => {
  const repo = initRepo();
  expect(createStoryWorktree({ rootDir: repo, sandbox_root: '../evil' })).toMatchObject({ ok: false, reason: 'worktree_sandbox_root_not_allowed' });
  expect(createStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY', base_ref: 'evil; rm -rf /' })).toMatchObject({ ok: false, reason: 'worktree_base_ref_invalid' });
});

test('createStoryWorktree creates a detached worktree and exposes base_sha', () => {
  const repo = initRepo();
  const result = createStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-CREATE' });
  expect(result.ok).toBe(true);
  expect(result.worktree_path).toBe('.ralph/sandboxes/STORY-CREATE/worktree');
  expect(fs.existsSync(path.join(repo, result.worktree_path, 'README.md'))).toBe(true);
  expect(result.base_sha).toMatch(/^[a-f0-9]{40}$/);
});

test('createStoryWorktree replaces a pre-existing worktree directory', () => {
  const repo = initRepo();
  const first = createStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-REUSE' });
  expect(first.ok).toBe(true);
  fs.writeFileSync(path.join(repo, first.worktree_path, 'stale.txt'), 'stale\n');

  const second = createStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-REUSE' });
  expect(second.ok).toBe(true);
  expect(fs.existsSync(path.join(repo, second.worktree_path, 'stale.txt'))).toBe(false);
});

test('diffStoryWorktree captures new files via intent-to-add and modifications via diff HEAD', () => {
  const repo = initRepo();
  const created = createStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-DIFF' });
  expect(created.ok).toBe(true);

  const worktreeAbs = path.join(repo, created.worktree_path);
  fs.mkdirSync(path.join(worktreeAbs, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(worktreeAbs, 'docs', 'new.md'), '# new\nbody\n');
  fs.writeFileSync(path.join(worktreeAbs, 'README.md'), '# repo\nupdated\n');

  const diff = diffStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-DIFF' });
  expect(diff.ok).toBe(true);
  expect(diff.patch_text).toContain('diff --git a/docs/new.md b/docs/new.md');
  expect(diff.patch_text).toContain('diff --git a/README.md b/README.md');
  expect(diff.patch_text).toMatch(/\+# new/);
  expect(diff.patch_text).toMatch(/\+updated/);
});

test('diffStoryWorktree excludes candidate.patch / candidate.diff / .opencode written by agents', () => {
  const repo = initRepo();
  const created = createStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-EXCLUDE' });
  expect(created.ok).toBe(true);

  const worktreeAbs = path.join(repo, created.worktree_path);
  // Real edit the agent should produce
  fs.mkdirSync(path.join(worktreeAbs, 'src', 'ralph'), { recursive: true });
  fs.writeFileSync(path.join(worktreeAbs, 'src', 'ralph', 'clamp.js'), 'module.exports = {};\n');
  // Spurious files the agent might also leave behind
  fs.writeFileSync(path.join(worktreeAbs, 'candidate.patch'), 'diff --git a/x b/x\n');
  fs.writeFileSync(path.join(worktreeAbs, 'candidate.diff'), 'spurious\n');
  fs.mkdirSync(path.join(worktreeAbs, '.opencode'), { recursive: true });
  fs.writeFileSync(path.join(worktreeAbs, '.opencode', 'session.json'), '{}\n');

  const diff = diffStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-EXCLUDE' });
  expect(diff.ok).toBe(true);
  expect(diff.patch_text).toContain('diff --git a/src/ralph/clamp.js b/src/ralph/clamp.js');
  expect(diff.patch_text).not.toContain('candidate.patch');
  expect(diff.patch_text).not.toContain('candidate.diff');
  expect(diff.patch_text).not.toContain('.opencode/session.json');
});

test('destroyStoryWorktree cleans both git worktree metadata and the directory', () => {
  const repo = initRepo();
  const created = createStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-DESTROY' });
  expect(created.ok).toBe(true);
  expect(fs.existsSync(path.join(repo, created.worktree_path))).toBe(true);

  const removed = destroyStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-DESTROY' });
  expect(removed).toMatchObject({ ok: true, removed: true });
  expect(fs.existsSync(path.join(repo, created.worktree_path))).toBe(false);
});

test('destroyStoryWorktree on absent worktree returns ok without errors', () => {
  const repo = initRepo();
  const removed = destroyStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-ABSENT' });
  expect(removed).toMatchObject({ ok: true, removed: false });
});

test('createStoryWorktree fails cleanly when base_ref does not exist', () => {
  const repo = initRepo();
  const result = createStoryWorktree({ rootDir: repo, sandbox_root: '.ralph/sandboxes/STORY-BAD-REF', base_ref: 'does-not-exist' });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('worktree_create_failed');
});
