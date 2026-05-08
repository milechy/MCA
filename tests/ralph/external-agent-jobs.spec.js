const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultExternalAgentJobId, safeExternalAgentJobId, writeExternalAgentJob, readExternalAgentJob, externalAgentJobStatus, abortExternalAgentJob } = require('../../src/ralph/external-agent-jobs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-external-agent-jobs-'));
}

test('external agent job ids are scoped to external agent jobs', () => {
  expect(defaultExternalAgentJobId(new Date('2026-05-08T09:00:00.000Z'))).toBe('JOB-EXTAGENT-20260508090000');
  expect(safeExternalAgentJobId('JOB-EXTAGENT-ABC_123')).toBe('JOB-EXTAGENT-ABC_123');
  expect(safeExternalAgentJobId('JOB-OPENCODE-ABC')).toBe(null);
});

test('writeExternalAgentJob records bounded non-mutating summary', () => {
  const rootDir = tmpRoot();
  const written = writeExternalAgentJob(rootDir, {
    job_id: 'JOB-EXTAGENT-1',
    status: 'completed',
    approval_id: 'APR-1',
    gateway_type: 'nemoclaw',
    gateway_name: 'nemoclaw',
    sandbox_root: '.ralph/tmp/gateway/APR-1',
    candidate_patch_path: '.ralph/tmp/gateway/APR-1/candidate.patch',
    task_preview: 'add test',
    stdout_preview: 'candidate patch written',
    execution_connected: true,
    real_gateway_process_started: true,
    files_modified: ['.ralph/tmp/gateway/APR-1/candidate.patch'],
    repository_files_modified: ['src/example.js'],
    deploy_performed: true,
    migration_performed: true,
    next_action: 'preview_candidate_patch_before_apply'
  });
  expect(written.ok).toBe(true);
  expect(written.summary).toMatchObject({
    ok: true,
    stage: 'external_agent_job_status',
    job_id: 'JOB-EXTAGENT-1',
    status: 'completed',
    gateway_type: 'nemoclaw',
    candidate_patch_path: '.ralph/tmp/gateway/APR-1/candidate.patch',
    execution_connected: true,
    real_gateway_process_started: true,
    files_modified: ['.ralph/tmp/gateway/APR-1/candidate.patch'],
    repository_files_modified: [],
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false
  });
  expect(readExternalAgentJob(rootDir, 'JOB-EXTAGENT-1').repository_files_modified).toEqual([]);
});

test('externalAgentJobStatus lists and retrieves jobs', () => {
  const rootDir = tmpRoot();
  writeExternalAgentJob(rootDir, { job_id: 'JOB-EXTAGENT-1', status: 'completed', gateway_type: 'nemoclaw' });
  expect(externalAgentJobStatus({ rootDir, job_id: 'JOB-EXTAGENT-1' })).toMatchObject({ ok: true, stage: 'external_agent_job_status', job_id: 'JOB-EXTAGENT-1', jobs: [{ job_id: 'JOB-EXTAGENT-1' }] });
  expect(externalAgentJobStatus({ rootDir }).jobs).toHaveLength(1);
  expect(externalAgentJobStatus({ rootDir, job_id: 'JOB-EXTAGENT-NOPE' })).toMatchObject({ ok: false, reason: 'job_not_found' });
});

test('abortExternalAgentJob marks running job aborted without execution effects', () => {
  const rootDir = tmpRoot();
  writeExternalAgentJob(rootDir, { job_id: 'JOB-EXTAGENT-ABORT', status: 'running', gateway_type: 'openclaw', execution_connected: true, commands_executed: ['openclaw run'], files_modified: ['.ralph/tmp/gateway/APR-1/candidate.patch'] });
  const result = abortExternalAgentJob({ rootDir, job_id: 'JOB-EXTAGENT-ABORT', now: new Date('2026-05-08T09:10:00.000Z') });
  expect(result).toMatchObject({
    ok: true,
    stage: 'external_agent_job_abort',
    reason: null,
    status: 'aborted',
    abort_requested: true,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    deploy_performed: false,
    migration_performed: false
  });
  expect(readExternalAgentJob(rootDir, 'JOB-EXTAGENT-ABORT').status).toBe('aborted');
});
