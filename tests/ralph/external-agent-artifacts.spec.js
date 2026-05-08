const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeExternalAgentJob } = require('../../src/ralph/external-agent-jobs');
const { readExternalAgentBoundedArtifact } = require('../../src/ralph/external-agent-artifacts');

function tmpRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-external-agent-artifacts-'));
  fs.mkdirSync(path.join(rootDir, '.ralph/tmp/gateway/APR-1'), { recursive: true });
  return rootDir;
}

function seedJob(rootDir, overrides = {}) {
  writeExternalAgentJob(rootDir, {
    job_id: 'JOB-EXTAGENT-ARTIFACT',
    status: 'completed',
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw',
    sandbox_root: '.ralph/tmp/gateway/APR-1',
    candidate_patch_path: '.ralph/tmp/gateway/APR-1/candidate.patch',
    stdout_preview: 'candidate patch written',
    stderr_preview: 'warning none',
    files_modified: ['.ralph/tmp/gateway/APR-1/candidate.patch'],
    ...overrides
  });
}

test('readExternalAgentBoundedArtifact reads candidate.patch only inside sandbox', () => {
  const rootDir = tmpRoot();
  seedJob(rootDir);
  fs.writeFileSync(path.join(rootDir, '.ralph/tmp/gateway/APR-1/candidate.patch'), 'diff --git a/tests/x.js b/tests/x.js\n--- /dev/null\n+++ b/tests/x.js\n@@ -0,0 +1 @@\n+test\n', 'utf8');
  const result = readExternalAgentBoundedArtifact({ rootDir, job_id: 'JOB-EXTAGENT-ARTIFACT' });
  expect(result).toMatchObject({
    ok: true,
    stage: 'external_agent_artifact_retrieval',
    reason: null,
    job_id: 'JOB-EXTAGENT-ARTIFACT',
    artifact_type: 'candidate_patch',
    path: '.ralph/tmp/gateway/APR-1/candidate.patch',
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
  expect(result.content).toContain('diff --git');
});

test('readExternalAgentBoundedArtifact blocks non candidate patch paths and missing jobs', () => {
  const rootDir = tmpRoot();
  seedJob(rootDir);
  fs.writeFileSync(path.join(rootDir, '.ralph/tmp/gateway/APR-1/other.patch'), 'nope', 'utf8');
  expect(readExternalAgentBoundedArtifact({ rootDir, job_id: 'JOB-EXTAGENT-NOPE' })).toMatchObject({ ok: false, reason: 'job_not_found' });
  expect(readExternalAgentBoundedArtifact({ rootDir, job_id: 'JOB-EXTAGENT-ARTIFACT', artifact_path: '.ralph/tmp/gateway/APR-1/other.patch' })).toMatchObject({ ok: false, reason: 'artifact_path_not_allowed' });
  expect(readExternalAgentBoundedArtifact({ rootDir, job_id: 'JOB-EXTAGENT-ARTIFACT', artifact_type: 'raw_log' })).toMatchObject({ ok: false, reason: 'artifact_type_not_allowed' });
});

test('readExternalAgentBoundedArtifact returns bounded stdout and stderr previews', () => {
  const rootDir = tmpRoot();
  seedJob(rootDir, { stdout_preview: 'line1\nline2\nline3', stderr_preview: 'err1\nerr2' });
  expect(readExternalAgentBoundedArtifact({ rootDir, job_id: 'JOB-EXTAGENT-ARTIFACT', artifact_type: 'stdout', max_lines: 2 })).toMatchObject({ ok: true, artifact_type: 'stdout', content: 'line1 line2 line3' });
  expect(readExternalAgentBoundedArtifact({ rootDir, job_id: 'JOB-EXTAGENT-ARTIFACT', artifact_type: 'stderr', max_lines: 1 })).toMatchObject({ ok: true, artifact_type: 'stderr', content: 'err1 err2' });
});

test('readExternalAgentBoundedArtifact redacts and truncates content', () => {
  const rootDir = tmpRoot();
  seedJob(rootDir);
  const token = ['ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('');
  fs.writeFileSync(path.join(rootDir, '.ralph/tmp/gateway/APR-1/candidate.patch'), `secret ${token}\n${Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ')}`, 'utf8');
  const result = readExternalAgentBoundedArtifact({ rootDir, job_id: 'JOB-EXTAGENT-ARTIFACT', max_chars: 30 });
  expect(result.ok).toBe(true);
  expect(result.content).toContain('<redacted>');
  expect(result.content).not.toContain(token);
  expect(result.truncated).toBe(true);
});
