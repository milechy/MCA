const fs = require('node:fs');
const path = require('node:path');

const JOB_STATUSES = Object.freeze(['planned', 'running', 'completed', 'failed', 'aborted']);
const JOB_DIR = path.join('.ralph', 'opencode-jobs');
const MAX_PREVIEW_CHARS = 240;

function jobDir(rootDir) {
  return path.join(rootDir, JOB_DIR);
}

function jobPath(rootDir, job_id) {
  return path.join(jobDir(rootDir), `${safeJobId(job_id)}.json`);
}

function safeJobId(job_id) {
  const value = String(job_id || '').trim();
  if (!/^JOB-OPENCODE-[A-Z0-9_-]{1,80}$/.test(value)) return null;
  return value;
}

function defaultJobId(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `JOB-OPENCODE-${stamp}`;
}

function oneLine(value, maxLength = MAX_PREVIEW_CHARS) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:\b\d{8,}:[A-Za-z0-9_-]{20,}\b|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})/g, '<redacted>');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeStatus(status) {
  const value = String(status || '').trim();
  return JOB_STATUSES.includes(value) ? value : null;
}

function summarizeJob(job) {
  return {
    ok: true,
    stage: 'opencode_job_status',
    reason: null,
    job_id: job.job_id,
    status: job.status,
    approval_id: job.approval_id || null,
    sandbox_root: job.sandbox_root || null,
    command_type: job.command_type || null,
    task_preview: oneLine(job.task_preview || ''),
    started_at: job.started_at || null,
    updated_at: job.updated_at || null,
    finished_at: job.finished_at || null,
    exit_code: Number.isInteger(job.exit_code) ? job.exit_code : null,
    stdout_preview: oneLine(job.stdout_preview || ''),
    stderr_preview: oneLine(job.stderr_preview || ''),
    execution_connected: job.execution_connected === true,
    opencode_execution_started: job.opencode_execution_started === true,
    abort_requested: job.abort_requested === true,
    commands_executed: Array.isArray(job.commands_executed) ? job.commands_executed.map((entry) => oneLine(entry, 160)).slice(0, 5) : [],
    files_modified: Array.isArray(job.files_modified) ? job.files_modified.slice(0, 20) : [],
    repository_files_modified: Array.isArray(job.repository_files_modified) ? job.repository_files_modified.slice(0, 20) : [],
    commit_created: job.commit_created === true,
    push_performed: job.push_performed === true,
    pr_created: job.pr_created === true,
    merge_performed: job.merge_performed === true,
    deploy_performed: job.deploy_performed === true,
    migration_performed: job.migration_performed === true,
    next_action: job.next_action || null
  };
}

function writeJob(rootDir, job) {
  const id = safeJobId(job.job_id);
  if (!id) return { ok: false, reason: 'job_id_not_allowed' };
  const status = normalizeStatus(job.status);
  if (!status) return { ok: false, reason: 'job_status_not_allowed' };
  const record = {
    job_id: id,
    status,
    approval_id: job.approval_id || null,
    sandbox_root: job.sandbox_root || null,
    command_type: job.command_type || 'opencode',
    task_preview: oneLine(job.task_preview || ''),
    started_at: job.started_at || new Date().toISOString(),
    updated_at: job.updated_at || new Date().toISOString(),
    finished_at: job.finished_at || null,
    exit_code: Number.isInteger(job.exit_code) ? job.exit_code : null,
    stdout_preview: oneLine(job.stdout_preview || ''),
    stderr_preview: oneLine(job.stderr_preview || ''),
    execution_connected: job.execution_connected === true,
    opencode_execution_started: job.opencode_execution_started === true,
    abort_requested: job.abort_requested === true,
    commands_executed: Array.isArray(job.commands_executed) ? job.commands_executed.map((entry) => oneLine(entry, 160)).slice(0, 5) : [],
    files_modified: Array.isArray(job.files_modified) ? job.files_modified.slice(0, 20) : [],
    repository_files_modified: Array.isArray(job.repository_files_modified) ? job.repository_files_modified.slice(0, 20) : [],
    commit_created: job.commit_created === true,
    push_performed: job.push_performed === true,
    pr_created: job.pr_created === true,
    merge_performed: job.merge_performed === true,
    deploy_performed: job.deploy_performed === true,
    migration_performed: job.migration_performed === true,
    next_action: job.next_action || null
  };
  fs.mkdirSync(jobDir(rootDir), { recursive: true });
  fs.writeFileSync(jobPath(rootDir, id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { ok: true, reason: null, job: record, summary: summarizeJob(record) };
}

function readJob(rootDir, job_id) {
  const id = safeJobId(job_id);
  if (!id) return null;
  const filePath = jobPath(rootDir, id);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listJobs(rootDir, { limit = 10 } = {}) {
  const dir = jobDir(rootDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, Math.max(1, Math.min(25, limit)))
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function opencodeJobStatus({ rootDir = process.cwd(), job_id, limit = 10 } = {}) {
  if (job_id) {
    const job = readJob(rootDir, job_id);
    if (!job) {
      return { ok: false, stage: 'opencode_job_status', reason: 'job_not_found', job_id: safeJobId(job_id), jobs: [], execution_connected: false, commands_executed: [], files_modified: [], deploy_performed: false, migration_performed: false };
    }
    return { ...summarizeJob(job), jobs: [summarizeJob(job)] };
  }
  return {
    ok: true,
    stage: 'opencode_job_status',
    reason: null,
    job_id: null,
    jobs: listJobs(rootDir, { limit }).map(summarizeJob),
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    deploy_performed: false,
    migration_performed: false,
    next_action: 'inspect_job_or_continue_operator_flow'
  };
}

function abortOpenCodeJob({ rootDir = process.cwd(), job_id, now = new Date() } = {}) {
  const job = readJob(rootDir, job_id);
  if (!job) return { ok: false, stage: 'opencode_job_abort', reason: 'job_not_found', job_id: safeJobId(job_id), execution_connected: false, abort_requested: false, commands_executed: [], files_modified: [], deploy_performed: false, migration_performed: false };
  if (job.status !== 'running') {
    return { ...summarizeJob(job), ok: false, stage: 'opencode_job_abort', reason: 'job_not_running', abort_requested: job.abort_requested === true, execution_connected: false, commands_executed: [], files_modified: [], deploy_performed: false, migration_performed: false, next_action: 'inspect_job_status' };
  }
  const updated = {
    ...job,
    status: 'aborted',
    abort_requested: true,
    updated_at: now.toISOString(),
    finished_at: now.toISOString(),
    exit_code: null,
    execution_connected: false,
    opencode_execution_started: job.opencode_execution_started === true,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'inspect_job_status_then_cleanup_sandbox'
  };
  const written = writeJob(rootDir, updated);
  return { ...written.summary, ok: true, stage: 'opencode_job_abort', reason: null, abort_requested: true };
}

module.exports = { JOB_STATUSES, defaultJobId, safeJobId, writeJob, readJob, listJobs, opencodeJobStatus, abortOpenCodeJob, summarizeJob };
