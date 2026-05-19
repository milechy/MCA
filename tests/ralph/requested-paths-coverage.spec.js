const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  COVERAGE_VERSION,
  normalizePath,
  gitStatusTouched,
  checkRequestedPathsCoverage,
  repairInstructionForMissingPaths
} = require('../../src/ralph/requested-paths-coverage');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqpaths-coverage-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# initial\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('COVERAGE_VERSION is stable for downstream consumers', () => {
  expect(COVERAGE_VERSION).toBe('requested_paths_coverage_v0_1');
});

test('normalizePath: forward-slash, no leading ./, trimmed', () => {
  expect(normalizePath('foo/bar.js')).toBe('foo/bar.js');
  expect(normalizePath('./foo/bar.js')).toBe('foo/bar.js');
  expect(normalizePath('foo\\bar.js')).toBe('foo/bar.js');
  expect(normalizePath('  src/x.ts  ')).toBe('src/x.ts');
  expect(normalizePath('')).toBe('');
  expect(normalizePath(null)).toBe('');
});

test('Phase 2 #3b: empty requested_paths is trivially ok', () => {
  const rootDir = tmpRepo();
  const r = checkRequestedPathsCoverage({
    rootDir,
    story: { requested_paths: [] },
    apply_result: { repository_files_modified: ['src/anywhere.js'] }
  });
  expect(r.ok).toBe(true);
  expect(r.reason).toBe(null);
  expect(r.missing_paths).toEqual([]);
});

test('Phase 2 #3b: all requested paths touched -> ok', () => {
  const rootDir = tmpRepo();
  const r = checkRequestedPathsCoverage({
    rootDir,
    story: { requested_paths: ['scripts/a.sh', 'tests/b.spec.js'] },
    apply_result: { repository_files_modified: ['scripts/a.sh', 'tests/b.spec.js'] }
  });
  expect(r.ok).toBe(true);
  expect(r.missing_paths).toEqual([]);
  expect(r.touched_paths).toEqual(['scripts/a.sh', 'tests/b.spec.js']);
  expect(r.fallback_used).toBe(false);
});

test('Phase 2 #3b: PR #137 / #139 regression — only 1 of N paths touched -> fail with missing_paths', () => {
  // This is the exact failure mode observed in the smoke + 3a dogfood:
  // Kimi K2.6 wrote scripts/gates/path-filter.sh but skipped run-all.sh
  // and tests/ralph/path-filter.spec.js.
  const rootDir = tmpRepo();
  const r = checkRequestedPathsCoverage({
    rootDir,
    story: {
      requested_paths: [
        'scripts/gates/path-filter.sh',
        'scripts/gates/run-all.sh',
        'tests/ralph/path-filter.spec.js'
      ]
    },
    apply_result: { repository_files_modified: ['scripts/gates/path-filter.sh'] }
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('requested_paths_coverage_incomplete');
  expect(r.missing_paths).toEqual([
    'scripts/gates/run-all.sh',
    'tests/ralph/path-filter.spec.js'
  ]);
  expect(r.touched_paths).toEqual(['scripts/gates/path-filter.sh']);
});

test('Phase 2 #3b: paths are normalized for comparison (backslash, ./ prefix)', () => {
  const rootDir = tmpRepo();
  const r = checkRequestedPathsCoverage({
    rootDir,
    story: { requested_paths: ['./src/x.ts', 'src\\y.ts'] },
    apply_result: { repository_files_modified: ['src/x.ts', 'src/y.ts'] }
  });
  expect(r.ok).toBe(true);
  expect(r.missing_paths).toEqual([]);
});

test('Phase 2 #3b: extra touched paths are reported as informational, not a failure', () => {
  // The autonomous-loop's candidate_patch_unrequested_path preflight is
  // the gate that catches FORBIDDEN extras; this coverage check catches
  // OMISSIONS only.
  const rootDir = tmpRepo();
  const r = checkRequestedPathsCoverage({
    rootDir,
    story: { requested_paths: ['scripts/a.sh'] },
    apply_result: { repository_files_modified: ['scripts/a.sh', 'scripts/b.sh'] }
  });
  expect(r.ok).toBe(true);
  expect(r.missing_paths).toEqual([]);
  expect(r.extra_touched_paths).toEqual(['scripts/b.sh']);
});

test('Phase 2 #3b: fallback to git status when apply_result is null', () => {
  const rootDir = tmpRepo();
  fs.mkdirSync(path.join(rootDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'scripts/a.sh'), '#!/usr/bin/env bash\necho a\n');

  const r = checkRequestedPathsCoverage({
    rootDir,
    story: { requested_paths: ['scripts/a.sh'] },
    apply_result: null
  });
  expect(r.ok).toBe(true);
  expect(r.fallback_used).toBe(true);
  expect(r.touched_paths).toContain('scripts/a.sh');
});

test('Phase 2 #3b: fallback to git status when apply_result has empty repository_files_modified', () => {
  const rootDir = tmpRepo();
  fs.mkdirSync(path.join(rootDir, 'tests/ralph'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'tests/ralph/x.spec.js'), 'test = 1;\n');

  const r = checkRequestedPathsCoverage({
    rootDir,
    story: { requested_paths: ['tests/ralph/x.spec.js'] },
    apply_result: { repository_files_modified: [] }
  });
  expect(r.ok).toBe(true);
  expect(r.fallback_used).toBe(true);
});

test('Phase 2 #3b: gitStatusTouched handles renames (oldpath -> newpath)', () => {
  // We can't easily simulate a rename mid-stage status with sufficient
  // fidelity, but the parser must at least produce the destination path
  // when a status line contains ' -> '. Test the parser via a stub.
  // Direct test: pass a stubbed spawn that returns synthetic git output.
  const fakeSpawn = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'status') {
      return {
        status: 0,
        stdout: ' M scripts/a.sh\nR  scripts/old.sh -> scripts/new.sh\n?? tests/new-test.spec.js\n',
        stderr: ''
      };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call' };
  };
  const touched = gitStatusTouched('/fake', { spawn: fakeSpawn });
  expect(touched).toEqual([
    'scripts/a.sh',
    'scripts/new.sh',
    'tests/new-test.spec.js'
  ]);
});

test('Phase 2 #3b: repairInstructionForMissingPaths produces a usable FIX_LOOP prompt', () => {
  const instruction = repairInstructionForMissingPaths([
    'scripts/gates/run-all.sh',
    'tests/ralph/path-filter.spec.js'
  ]);
  expect(instruction).toContain('scripts/gates/run-all.sh');
  expect(instruction).toContain('tests/ralph/path-filter.spec.js');
  expect(instruction).toContain('ALL of the requested_paths');
  // No paths -> null
  expect(repairInstructionForMissingPaths([])).toBe(null);
  expect(repairInstructionForMissingPaths(null)).toBe(null);
});

test('Phase 2 #3b: touched_paths and missing_paths are sorted deterministically', () => {
  const rootDir = tmpRepo();
  const r = checkRequestedPathsCoverage({
    rootDir,
    story: {
      requested_paths: ['z/a.js', 'a/z.js', 'm/m.js', 'a/a.js']
    },
    apply_result: {
      repository_files_modified: ['m/m.js', 'a/a.js']  // half coverage
    }
  });
  expect(r.ok).toBe(false);
  // missing_paths preserves the order from requested_paths
  expect(r.missing_paths).toEqual(['z/a.js', 'a/z.js']);
  // touched_paths is normalized + sorted (uniqueSorted)
  expect(r.touched_paths).toEqual(['a/a.js', 'm/m.js']);
});
