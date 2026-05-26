const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { calculatePlanHash, canonicalJson, calculateDiffHash } = require('../../src/ralph/hash');

test('canonical JSON sorts object keys and removes volatile fields', () => {
  const a = {
    updated_at: 'later',
    story_id: 'STORY-1',
    objective: 'Build core',
    nested: { b: 2, a: 1 }
  };
  const b = {
    nested: { a: 1, b: 2 },
    objective: 'Build core',
    story_id: 'STORY-1',
    updated_at: 'now'
  };

  expect(canonicalJson(a)).toBe(canonicalJson(b));
  expect(calculatePlanHash(a)).toBe(calculatePlanHash(b));
});

// ============================================================
// Phase 7 #2: calculateDiffHash stderr silence regression guard
// ============================================================
//
// Phase 6 #5 / Phase 7 #1 traced the long-running `./**` flake to this
// function. When cwd is a non-git directory (e.g. a test tmpdir without
// `git init`), the inner `git diff -- . :(exclude).ralph/**` exits non-
// zero AND emits `error: Could not access './**'` to stderr. The throw
// is harmless (caller uses safePreExecDiffHash with try/catch), but the
// stderr leak pollutes audit logs and falsely triggers Phase 5 #2's
// retry-on-flake regex. The fix is `stdio: [..., ..., 'ignore']`.

test('Phase 7 #2: calculateDiffHash throws on a non-git cwd but does NOT leak stderr', () => {
  // Spawn a child node that calls calculateDiffHash() in a non-git tmpdir.
  // We need a separate process so we can capture *its* stderr in full.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-02-non-git-'));
  // No `git init` — this is exactly the shape many ralph specs use.
  const script = `
    const { calculateDiffHash } = require(${JSON.stringify(path.resolve(__dirname, '../../src/ralph/hash.js'))});
    try {
      calculateDiffHash(${JSON.stringify(tmpdir)});
      console.log('did_not_throw');
    } catch (e) {
      console.log('threw_exit=' + (e && e.status));
    }
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Cleanup
  fs.rmSync(tmpdir, { recursive: true, force: true });

  // The function must still throw on a non-git cwd (callers rely on the
  // try/catch + sentinel-hash pattern in safePreExecDiffHash).
  expect(r.stdout).toContain('threw_exit=');
  // But the stderr leak must be GONE.
  expect(r.stderr).not.toContain('Could not access');
  expect(r.stderr).not.toContain('./**');
  // Nothing else should appear on stderr either (no warnings).
  expect(r.stderr.trim()).toBe('');
});

test('Phase 7 #2: calculateDiffHash returns a valid sha256 on a real git repo', () => {
  // Sanity: the happy path still works.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-02-real-git-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpdir });
  spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: tmpdir });
  const hash = calculateDiffHash(tmpdir);
  fs.rmSync(tmpdir, { recursive: true, force: true });
  expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
});
