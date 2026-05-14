const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseFailedGateName } = require('../../src/telegram/opencode-gates');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-failure-naming-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'scripts/gates'), { recursive: true });
  // Wire up the real run-all.sh
  fs.copyFileSync(
    path.join(__dirname, '..', '..', 'scripts/gates/run-all.sh'),
    path.join(dir, 'scripts/gates/run-all.sh')
  );
  fs.chmodSync(path.join(dir, 'scripts/gates/run-all.sh'), 0o755);
  return dir;
}

function writeGate(repo, name, body) {
  const file = path.join(repo, 'scripts/gates', `${name}.sh`);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function writeAllGatesPassing(repo) {
  for (const name of ['secret-scan', 'ralph-tests', 'telegram-tests', 'supabase-local', 'playwright-e2e']) {
    writeGate(repo, name, 'echo "passed"; exit 0');
  }
}

test('parseFailedGateName extracts the sub-gate name from a real run-all FAILED_GATE line', () => {
  const stdout = [
    '[gate] start: pre-secret-scan',
    '[secret-scan] passed',
    '[gate] passed: pre-secret-scan',
    '[gate] start: ralph-tests',
    'some inner output...',
    '[gate] FAILED_GATE=ralph-tests',
    '[gate] failed: ralph-tests'
  ].join('\n');
  expect(parseFailedGateName(stdout, '')).toBe('ralph-tests');
});

test('parseFailedGateName falls back to stderr if stdout did not carry the line', () => {
  expect(parseFailedGateName('', '[gate] FAILED_GATE=supabase-local\n')).toBe('supabase-local');
});

test('parseFailedGateName returns null when no FAILED_GATE line is present', () => {
  expect(parseFailedGateName('all good\n', '')).toBeNull();
});

test('parseFailedGateName refuses unsafe gate names', () => {
  // attempts to inject a shell metachar / path-shape into the captured name
  expect(parseFailedGateName('[gate] FAILED_GATE=rm -rf /\n', '')).toBeNull();
  expect(parseFailedGateName('[gate] FAILED_GATE=$(evil)\n', '')).toBeNull();
  expect(parseFailedGateName('[gate] FAILED_GATE=../etc/passwd\n', '')).toBeNull();
});

test('run-all.sh emits [gate] FAILED_GATE=<name> when a sub-gate fails', () => {
  const repo = tmpRepo();
  writeAllGatesPassing(repo);
  // Replace the supabase-local gate with a failing one — second gate in the
  // run-all.sh sequence (pre-secret-scan, ralph-tests, telegram-tests,
  // supabase-local, playwright-e2e, post-secret-scan). We force supabase-local
  // to fail and assert the structured line carries its name.
  writeGate(repo, 'supabase-local', 'echo "docker is not running"; exit 1');
  const r = spawnSync('bash', ['scripts/gates/run-all.sh'], { cwd: repo, encoding: 'utf8' });
  expect(r.status).not.toBe(0);
  expect(r.stdout).toMatch(/\[gate\]\s*FAILED_GATE=supabase-local/);
  expect(parseFailedGateName(r.stdout, r.stderr)).toBe('supabase-local');
});

test('run-all.sh passes cleanly and emits no FAILED_GATE line when every sub-gate succeeds', () => {
  const repo = tmpRepo();
  writeAllGatesPassing(repo);
  const r = spawnSync('bash', ['scripts/gates/run-all.sh'], { cwd: repo, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain('FAILED_GATE=');
  expect(r.stdout).toContain('[gate] all Phase 2 local gates passed');
});

test('run-all.sh stops at the first failing gate and only reports that one', () => {
  const repo = tmpRepo();
  writeAllGatesPassing(repo);
  writeGate(repo, 'ralph-tests', 'echo "boom"; exit 1');
  writeGate(repo, 'supabase-local', 'echo "would also fail"; exit 1');
  const r = spawnSync('bash', ['scripts/gates/run-all.sh'], { cwd: repo, encoding: 'utf8' });
  expect(r.status).not.toBe(0);
  // We expect ralph-tests (first failure) to be reported, not supabase-local.
  expect(parseFailedGateName(r.stdout, r.stderr)).toBe('ralph-tests');
  expect(r.stdout).not.toContain('FAILED_GATE=supabase-local');
});
