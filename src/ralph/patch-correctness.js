const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Phase C — correctness gate for the shadow comparison.
//
// "Valid unified diff" (what openclaw-shadow measured) is necessary but not
// sufficient: the migration decision needs "do the generated patch's tests
// actually pass?". This module applies an ADD-ONLY candidate patch into the
// real repo (so node_modules, the playwright config, and relative requires all
// resolve), runs the added test file(s), then reverts — leaving the tree clean.
//
// Add-only guard: we ONLY apply patches that create new files (every hunk has
// `--- /dev/null`). A patch that modifies an existing file is rejected
// (tests_passed=null, reason=patch_modifies_existing) rather than risk mutating
// tracked code. Our shadow tasks are all add-only, so this covers them.

// Parse a unified diff: which files it ADDS, and whether it touches existing
// files. Pure.
function analyzePatch(patchText) {
  const text = String(patchText || '');
  const lines = text.split('\n');
  const added_paths = [];
  let modifies_existing = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('--- ')) continue;
    const src = lines[i].slice(4).trim();
    const next = lines[i + 1] || '';
    if (!next.startsWith('+++ ')) continue;
    const dst = next.slice(4).trim();
    if (src === '/dev/null') {
      const p = dst.replace(/^b\//, '').trim();
      if (p && p !== '/dev/null') added_paths.push(p);
    } else {
      modifies_existing = true;
    }
  }
  return { add_only: !modifies_existing && added_paths.length > 0, added_paths, modifies_existing };
}

function testPathsFrom(added_paths) {
  return added_paths.filter((p) => /\.(spec|test)\.[jt]sx?$/.test(p));
}

// Apply (add-only) → run tests → revert. Returns { ok, applied, tests_passed,
// reason }. spawn is injectable for tests; the real one is spawnSync.
function applyAndTest({
  rootDir = process.cwd(),
  patchText,
  testPaths = null,
  env = process.env,
  spawn = spawnSync,
  configPath = 'playwright.ralph.config.js',
  timeoutMs = 120000,
  fsImpl = fs
} = {}) {
  const analysis = analyzePatch(patchText);
  if (!analysis.add_only) {
    return { ok: false, applied: false, tests_passed: null, reason: analysis.modifies_existing ? 'patch_modifies_existing' : 'no_added_paths', added_paths: analysis.added_paths };
  }

  const check = spawn('git', ['apply', '--check', '-'], { cwd: rootDir, input: patchText, encoding: 'utf8', env });
  if (!check || check.status !== 0) {
    return { ok: false, applied: false, tests_passed: null, reason: 'git_apply_check_failed', stderr_preview: String((check && check.stderr) || '').slice(0, 300), added_paths: analysis.added_paths };
  }
  const apply = spawn('git', ['apply', '-'], { cwd: rootDir, input: patchText, encoding: 'utf8', env });
  if (!apply || apply.status !== 0) {
    return { ok: false, applied: false, tests_passed: null, reason: 'git_apply_failed', stderr_preview: String((apply && apply.stderr) || '').slice(0, 300), added_paths: analysis.added_paths };
  }

  try {
    const tests = testPaths && testPaths.length ? testPaths : testPathsFrom(analysis.added_paths);
    if (!tests.length) {
      return { ok: true, applied: true, tests_passed: null, reason: 'no_test_file_in_patch', added_paths: analysis.added_paths };
    }
    const run = spawn('npx', ['playwright', 'test', `--config=${configPath}`, ...tests], {
      cwd: rootDir, encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024
    });
    const tests_passed = Boolean(run && run.status === 0);
    return {
      ok: true,
      applied: true,
      tests_passed,
      reason: null,
      added_paths: analysis.added_paths,
      test_paths: tests,
      test_output_preview: String((run && (run.stdout || '')) + (run && (run.stderr || ''))).slice(-400)
    };
  } finally {
    // Revert: reverse-apply, then hard-remove any leftover added files so the
    // working tree is left exactly as we found it.
    spawn('git', ['apply', '-R', '-'], { cwd: rootDir, input: patchText, encoding: 'utf8', env });
    for (const p of analysis.added_paths) {
      try { fsImpl.rmSync(path.join(rootDir, p), { force: true }); } catch { /* best effort */ }
    }
  }
}

module.exports = { analyzePatch, testPathsFrom, applyAndTest };
