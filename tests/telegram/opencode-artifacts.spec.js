const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { writeJob } = require('../../src/telegram/opencode-jobs');
const { redact, boundedText, tailLines, readBoundedArtifact } = require('../../src/telegram/opencode-artifacts');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-artifacts-'));
}

function fakeTelegramToken() {
  return ['12345678', ':', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'].join('');
}

function fakeGithubToken() {
  return ['ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('');
}

function setupJob(rootDir) {
  const sandboxRoot = '.ralph/tmp/opencode-sandbox/APR-1';
  fs.mkdirSync(path.join(rootDir, sandboxRoot), { recursive: true });
  fs.writeFileSync(path.join(rootDir, sandboxRoot, 'candidate.patch'), ['line1', 'line2', `secret ${fakeTelegramToken()}`, 'line4'].join('\n'));
  writeJob(rootDir, {
    job_id: 'JOB-OPENCODE-1',
    status: 'completed',
    approval_id: 'APR-1',
    sandbox_root: sandboxRoot,
    stdout_preview: `stdout token ${fakeGithubToken()}`,
    stderr_preview: 'stderr ok'
  });
  return sandboxRoot;
}

test('parseTelegramCommand parses /opencode-artifact', () => {
  expect(parseTelegramCommand('/opencode-artifact JOB-OPENCODE-1 candidate_patch')).toMatchObject({ type: 'opencode_artifact', args: ['JOB-OPENCODE-1', 'candidate_patch'] });
});

test('redact and boundedText remove token-like content and limit output', () => {
  expect(redact(`x TELEGRAM_BOT_TOKEN=${fakeTelegramToken()} y`)).toContain('TELEGRAM_BOT_TOKEN=<redacted>');
  expect(boundedText('x'.repeat(20), 5)).toBe('xxxx…');
  expect(tailLines(['a', 'b', 'c'].join('\n'), 2)).toBe('b\nc');
});

test('readBoundedArtifact reads only sandbox-local candidate patch and redacts content', () => {
  const rootDir = tmpRoot();
  const sandboxRoot = setupJob(rootDir);
  const result = readBoundedArtifact({ rootDir, job_id: 'JOB-OPENCODE-1', artifact_type: 'candidate_patch', artifact_path: path.join(sandboxRoot, 'candidate.patch') });
  expect(result).toMatchObject({
    ok: true,
    stage: 'opencode_artifact_retrieval',
    reason: null,
    job_id: 'JOB-OPENCODE-1',
    artifact_type: 'candidate_patch',
    path: '.ralph/tmp/opencode-sandbox/APR-1/candidate.patch',
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
  expect(result.content).toContain('<redacted>');
  expect(result.content).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
});

test('readBoundedArtifact blocks path traversal and unsupported artifact types', () => {
  const rootDir = tmpRoot();
  setupJob(rootDir);
  expect(readBoundedArtifact({ rootDir, job_id: 'JOB-OPENCODE-1', artifact_type: 'candidate_patch', artifact_path: '../../etc/passwd' }).reason).toBe('artifact_path_not_allowed');
  expect(readBoundedArtifact({ rootDir, job_id: 'JOB-OPENCODE-1', artifact_type: 'raw_log' }).reason).toBe('artifact_type_not_allowed');
});

test('readBoundedArtifact returns stdout and stderr previews without file reads', () => {
  const rootDir = tmpRoot();
  setupJob(rootDir);
  const stdout = readBoundedArtifact({ rootDir, job_id: 'JOB-OPENCODE-1', artifact_type: 'stdout' });
  expect(stdout.ok).toBe(true);
  expect(stdout.content).toContain('<redacted>');
  const stderr = readBoundedArtifact({ rootDir, job_id: 'JOB-OPENCODE-1', artifact_type: 'stderr' });
  expect(stderr.ok).toBe(true);
  expect(stderr.content).toBe('stderr ok');
});
