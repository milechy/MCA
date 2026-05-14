const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  // Copy the secret-scan script (and the run-all wrapper for symmetry) into
  // the temp repo so we can exercise it in isolation.
  fs.mkdirSync(path.join(dir, 'scripts/gates'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', '..', 'scripts/gates/secret-scan.sh'),
    path.join(dir, 'scripts/gates/secret-scan.sh')
  );
  fs.chmodSync(path.join(dir, 'scripts/gates/secret-scan.sh'), 0o755);
  // Minimal target directories the script scans
  for (const d of ['src', 'scripts', 'policies', 'docs', 'tests']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  return dir;
}

function runScan(dir) {
  return spawnSync('bash', ['scripts/gates/secret-scan.sh'], { cwd: dir, encoding: 'utf8' });
}

test('secret-scan passes on a clean tree', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, 'src/clean.js'), 'module.exports = {};\n');
  const r = runScan(repo);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('[secret-scan] passed');
});

test('secret-scan flags a real-looking OpenAI sk-* key', () => {
  const repo = tmpRepo();
  // NOSCAN-FIXTURE: this is the synthetic shape we want secret-scan to catch
  fs.writeFileSync(path.join(repo, 'src/leak.js'), "const KEY = 'sk-deadbeefdeadbeefdeadbeefdeadbeef';\n");
  const r = runScan(repo);
  expect(r.status).not.toBe(0);
  expect(r.stdout).toContain('potential secret detected');
});

test('secret-scan flags a real-looking GitHub ghp_ token', () => {
  const repo = tmpRepo();
  // NOSCAN-FIXTURE: synthetic ghp_ token shape
  fs.writeFileSync(path.join(repo, 'src/leak.js'), "const T = 'ghp_abcdefghijklmnopqrstuvwxyz0123';\n");
  const r = runScan(repo);
  expect(r.status).not.toBe(0);
});

test('secret-scan ignores a sk-* substring on a line marked with inline // NOSCAN-FIXTURE', () => {
  const repo = tmpRepo();
  fs.writeFileSync(
    path.join(repo, 'src/template.js'),
    [
      "// regular file",
      "const slug = 'risk-evaluator-conservative'; // NOSCAN-FIXTURE: template slug shape",
      ""
    ].join('\n')
  );
  const r = runScan(repo);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('[secret-scan] passed');
});

test('secret-scan ignores a sk-* substring on a line whose previous line is // NOSCAN-FIXTURE: ...', () => {
  const repo = tmpRepo();
  fs.writeFileSync(
    path.join(repo, 'tests/redactor.spec.js'),
    [
      "// NOSCAN-FIXTURE: test fixture for redactor; not a real secret",
      "const r = redactor('investigation reveals leak: sk-deadbeefdeadbeefdeadbeefdeadbeef');",
      ""
    ].join('\n')
  );
  const r = runScan(repo);
  expect(r.status).toBe(0);
});

test('secret-scan still flags a real-looking secret even if a nearby line carries // NOSCAN-FIXTURE for an unrelated line', () => {
  const repo = tmpRepo();
  fs.writeFileSync(
    path.join(repo, 'src/leak.js'),
    [
      "// NOSCAN-FIXTURE: this annotation applies to the next line only",
      "const dummy = 'risk-evaluator-conservative';  // not a secret",
      "const real = 'sk-deadbeefdeadbeefdeadbeefdeadbeef'; // real-looking, should still be caught",
      ""
    ].join('\n')
  );
  const r = runScan(repo);
  expect(r.status).not.toBe(0);
  expect(r.stdout).toContain('potential secret detected');
});

test('secret-scan accepts the # NOSCAN-FIXTURE form for shell scripts', () => {
  const repo = tmpRepo();
  fs.writeFileSync(
    path.join(repo, 'scripts/use.sh'),
    [
      "#!/usr/bin/env bash",
      "# NOSCAN-FIXTURE: example sk- shape in a script comment",
      "echo 'sk-deadbeefdeadbeefdeadbeefdeadbeef is just example output'",
      ""
    ].join('\n')
  );
  const r = runScan(repo);
  expect(r.status).toBe(0);
});
