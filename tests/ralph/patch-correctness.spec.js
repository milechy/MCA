const { test, expect } = require('@playwright/test');

const { analyzePatch, testPathsFrom, applyAndTest } = require('../../src/ralph/patch-correctness');

const ADD_ONLY = [
  'diff --git a/src/x.js b/src/x.js',
  '--- /dev/null',
  '+++ b/src/x.js',
  '@@ -0,0 +1,1 @@',
  '+module.exports = 1;',
  'diff --git a/tests/x.spec.js b/tests/x.spec.js',
  '--- /dev/null',
  '+++ b/tests/x.spec.js',
  '@@ -0,0 +1,1 @@',
  "+const { test } = require('@playwright/test');"
].join('\n');

const MODIFIES = [
  'diff --git a/src/existing.js b/src/existing.js',
  '--- a/src/existing.js',
  '+++ b/src/existing.js',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new'
].join('\n');

test('analyzePatch detects add-only and extracts added paths', () => {
  const a = analyzePatch(ADD_ONLY);
  expect(a.add_only).toBe(true);
  expect(a.added_paths).toEqual(['src/x.js', 'tests/x.spec.js']);
  expect(a.modifies_existing).toBe(false);
});

test('analyzePatch flags patches that modify existing files', () => {
  const a = analyzePatch(MODIFIES);
  expect(a.add_only).toBe(false);
  expect(a.modifies_existing).toBe(true);
});

test('testPathsFrom picks spec/test files only', () => {
  expect(testPathsFrom(['src/x.js', 'tests/x.spec.js', 'a/b.test.ts'])).toEqual(['tests/x.spec.js', 'a/b.test.ts']);
});

test('applyAndTest rejects a patch that modifies existing files (no apply)', () => {
  let applied = false;
  const spawn = (cmd, args) => { if (args && args.includes('apply') && !args.includes('--check')) applied = true; return { status: 0 }; };
  const r = applyAndTest({ patchText: MODIFIES, spawn });
  expect(r.reason).toBe('patch_modifies_existing');
  expect(r.applied).toBe(false);
  expect(applied).toBe(false);
});

test('applyAndTest reports tests_passed=true when playwright exits 0, and reverts', () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push(`${cmd} ${(args || []).join(' ')}`);
    return { status: 0, stdout: '2 passed', stderr: '' };
  };
  const r = applyAndTest({ patchText: ADD_ONLY, spawn, fsImpl: { rmSync() {} } });
  expect(r.ok).toBe(true);
  expect(r.applied).toBe(true);
  expect(r.tests_passed).toBe(true);
  expect(r.test_paths).toEqual(['tests/x.spec.js']);
  // reverted via reverse-apply
  expect(calls.some((c) => c.includes('apply -R'))).toBe(true);
});

test('applyAndTest reports tests_passed=false when playwright fails', () => {
  const spawn = (cmd, args) => {
    if (cmd === 'npx') return { status: 1, stdout: '1 failed', stderr: '' };
    return { status: 0 };
  };
  const r = applyAndTest({ patchText: ADD_ONLY, spawn, fsImpl: { rmSync() {} } });
  expect(r.tests_passed).toBe(false);
});

test('applyAndTest surfaces a failed git apply --check', () => {
  const spawn = (cmd, args) => {
    if (args && args.includes('--check')) return { status: 1, stderr: 'patch does not apply' };
    return { status: 0 };
  };
  const r = applyAndTest({ patchText: ADD_ONLY, spawn, fsImpl: { rmSync() {} } });
  expect(r.reason).toBe('git_apply_check_failed');
  expect(r.applied).toBe(false);
});

test('applyAndTest returns no_test_file_in_patch when the patch adds no tests', () => {
  const noTest = ['diff --git a/src/y.js b/src/y.js', '--- /dev/null', '+++ b/src/y.js', '@@ -0,0 +1,1 @@', '+module.exports = 2;'].join('\n');
  const spawn = () => ({ status: 0 });
  const r = applyAndTest({ patchText: noTest, spawn, fsImpl: { rmSync() {} } });
  expect(r.applied).toBe(true);
  expect(r.tests_passed).toBe(null);
  expect(r.reason).toBe('no_test_file_in_patch');
});
