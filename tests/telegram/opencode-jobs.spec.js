const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTelegramCommand } = require('../../src/telegram/command-parser');
const { defaultJobId, safeJobId, writeJob, readJob, opencodeJobStatus, abortOpenCodeJob } = require('../../src/telegram/opencode-jobs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-jobs-'));
}

test('parseTelegramCommand parses OpenCode job status and abort commands', () => {
  expect(parseTelegramCommand('/opencode-status JOB-OPENCODE-1')).toMatchObject({ type: 'opencode_status', args: ['JOB-OPENCODE-1'] });
  expect(parseTelegramCommand('/opencode-abort JOB-OPENCODE-1')).toMatchObject({ type: 'opencode_abort', args: ['JOB-OPENCODE-1'] });
});

test('defaultJobId and safeJobId are deterministic and strict', () => {
  expect(defaultJobId(new Date('2026-05-07T12:34:56.789Z'))).toBe('JOB-OPENCODE-20260507123456');
  expect(safeJobId('JOB-OPENCODE-ABC_123')).toBe('JOB-OPENCODE-ABC_123');
  expect(safeJobId('../bad')).toBe(null);
  expect(safeJobId('JOB-other')).toBe(null);
});

test('writeJob stores bounded redacted job metadata', () => {
  const rootDir = tmpRoot();
  const written = writeJob(rootDir, {
    job_id: 'JOB-OPENCODE-1',
    status: 'running',
    approval_id: 'APR-1',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-1',
    command_type: 'opencode_run',
    task_preview: `hello\nworld ${'x'.repeat(400)}`,
    started_at: '2026-05-07T00:00:00.000Z',
    updated_at: '2026-05-07T00:00:01.000Z',
    stdout_preview: 'token 12345678:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    execution_connected: true,
    opencode_execution_started: true,
    commands_executed: ['opencode run --diff-only --output candidate.patch'],
    files_modified: ['.ralph/tmp/opencode-sandbox/APR-1/candidate.patch'],
    deploy_performed: false,
    migration_performed: false,
    next_action: 'wait_for_completion'
  });

  expect(written.ok).toBe(true);
  const job = readJob(rootDir, 'JOB-OPENCODE-1');
  expect(job.status).toBe('running');
  expect(job.stdout_preview).toContain('<redacted>');
  expect(job.task_preview.length).toBeLessThanOrEqual(240);
  expect(job.deploy_performed).toBe(false);
  expect(job.migration_performed).toBe(false);
});

test('opencodeJobStatus returns bounded status summaries', () => {
  const rootDir = tmpRoot();
  writeJob(rootDir, { job_id: 'JOB-OPENCODE-1', status: 'completed', approval_id: 'APR-1', finished_at: '2026-05-07T00:00:02.000Z' });
  const one = opencodeJobStatus({ rootDir, job_id: 'JOB-OPENCODE-1' });
  expect(one).toMatchObject({ ok: true, stage: 'opencode_job_status', job_id: 'JOB-OPENCODE-1', status: 'completed', execution_connected: false, deploy_performed: false, migration_performed: false });
  const list = opencodeJobStatus({ rootDir });
  expect(list.ok).toBe(true);
  expect(list.jobs).toHaveLength(1);
});

test('abortOpenCodeJob marks only running jobs aborted without repo mutations', () => {
  const rootDir = tmpRoot();
  writeJob(rootDir, { job_id: 'JOB-OPENCODE-RUNNING', status: 'running', approval_id: 'APR-1', opencode_execution_started: true });
  writeJob(rootDir, { job_id: 'JOB-OPENCODE-DONE', status: 'completed', approval_id: 'APR-2' });

  const aborted = abortOpenCodeJob({ rootDir, job_id: 'JOB-OPENCODE-RUNNING', now: new Date('2026-05-07T00:00:03.000Z') });
  expect(aborted).toMatchObject({ ok: true, stage: 'opencode_job_abort', reason: null, job_id: 'JOB-OPENCODE-RUNNING', status: 'aborted', abort_requested: true, execution_connected: false, commands_executed: [], files_modified: [], repository_files_modified: [], deploy_performed: false, migration_performed: false });

  const notRunning = abortOpenCodeJob({ rootDir, job_id: 'JOB-OPENCODE-DONE' });
  expect(notRunning.ok).toBe(false);
  expect(notRunning.reason).toBe('job_not_running');
});
