const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ROLLBACK_VERSION,
  normalizePath,
  gatherPathsFromApplyResult,
  workingTreeIsClean,
  rollbackAppliedFiles
} = require('../../src/ralph/apply-rollback');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-rollback-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# initial\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('normalizePath rejects absolute, traversal, NUL, and unsafe-charset paths', () => {
  expect(normalizePath('docs/x.md')).toBe('docs/x.md');
  expect(normalizePath('./docs/x.md')).toBe('docs/x.md');
  expect(normalizePath('/etc/passwd')).toBeNull();
  expect(normalizePath('../etc/passwd')).toBeNull();
  expect(normalizePath('docs/\0evil')).toBeNull();
  expect(normalizePath('docs/$(rm -rf /)')).toBeNull();
});

test('gatherPathsFromApplyResult intersects apply result with requested_paths', () => {
  const apply = { repository_files_modified: ['docs/a.md', 'docs/b.md', 'src/evil.js'] };
  const requested = ['docs/a.md', 'docs/b.md'];
  expect(gatherPathsFromApplyResult(apply, requested)).toEqual(['docs/a.md', 'docs/b.md']);
});

test('gatherPathsFromApplyResult de-duplicates and caps at MAX_PATHS=50', () => {
  const many = Array.from({ length: 60 }, (_, i) => `docs/f${i}.md`);
  const apply = { repository_files_modified: many.concat(many) };
  expect(gatherPathsFromApplyResult(apply, many).length).toBe(50);
});

test('rollbackAppliedFiles removes a newly-created untracked file and leaves the tree clean', () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'new.md'), 'applied content\n');
  // simulate apply result
  const r = rollbackAppliedFiles({
    rootDir: repo,
    apply_result: { repository_files_modified: ['docs/new.md'] },
    requested_paths: ['docs/new.md']
  });
  expect(r).toMatchObject({ ok: true, version: ROLLBACK_VERSION });
  expect(fs.existsSync(path.join(repo, 'docs', 'new.md'))).toBe(false);
  const verify = workingTreeIsClean(repo);
  expect(verify).toMatchObject({ ok: true, clean: true });
});

test('rollbackAppliedFiles git-checkouts an existing tracked file back to HEAD content', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), '# initial\nmutated by apply\n');
  const before = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  expect(before).toContain('mutated');
  const r = rollbackAppliedFiles({
    rootDir: repo,
    apply_result: { repository_files_modified: ['README.md'] },
    requested_paths: ['README.md']
  });
  expect(r).toMatchObject({ ok: true });
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# initial\n');
});

test('rollbackAppliedFiles refuses paths not in requested_paths even if apply listed them', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'unauthorized.md'), 'this should NOT be cleaned up\n');
  const r = rollbackAppliedFiles({
    rootDir: repo,
    apply_result: { repository_files_modified: ['unauthorized.md'] },
    requested_paths: ['docs/something-else.md']
  });
  // Intersection is empty so no action is taken; the unauthorized file is
  // never touched — that is the safety property under test.
  expect(r.paths).toEqual([]);
  expect(r.actions).toEqual([]);
  expect(r.reason).toBe('no_paths_to_rollback');
  expect(fs.existsSync(path.join(repo, 'unauthorized.md'))).toBe(true);
});

test('rollbackAppliedFiles refuses path escaping rootDir', () => {
  const repo = tmpRepo();
  const r = rollbackAppliedFiles({
    rootDir: repo,
    apply_result: { repository_files_modified: ['docs/../etc/passwd'] },
    requested_paths: ['docs/../etc/passwd']
  });
  // normalizePath kills traversal first; result has empty paths
  expect(r.paths).toEqual([]);
});

test('rollbackAppliedFiles is a no-op when apply_result has no modified files', () => {
  const repo = tmpRepo();
  const r = rollbackAppliedFiles({ rootDir: repo, apply_result: {}, requested_paths: ['docs/x.md'] });
  expect(r).toMatchObject({ ok: true, reason: 'no_paths_to_rollback', paths: [], actions: [] });
});

test('rollbackAppliedFiles returns working_tree_still_dirty if a non-target file was left dirty', () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'target.md'), 'applied\n');
  // Operator's own unrelated edit, untargeted:
  fs.writeFileSync(path.join(repo, 'README.md'), '# initial\noperator edit\n');
  const r = rollbackAppliedFiles({
    rootDir: repo,
    apply_result: { repository_files_modified: ['docs/target.md'] },
    requested_paths: ['docs/target.md']
  });
  expect(r).toMatchObject({ ok: false, reason: 'working_tree_still_dirty' });
  // target was cleaned up but the unrelated edit is preserved
  expect(fs.existsSync(path.join(repo, 'docs', 'target.md'))).toBe(false);
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('operator edit');
});
