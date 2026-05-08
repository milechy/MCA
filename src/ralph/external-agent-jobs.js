const fs = require('node:fs');
const path = require('node:path');

const JOB_STATUSES = Object.freeze(['planned', 'running', 'completed', 'failed', 'aborted']);
const JOB_DIR = path.join('.ralph', 'external-agent-jobs');
const MAX_PREVIEW_CHARS = 240;

function oneLine(value, maxLength = MAX_PREVIEW_CHARS) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:\d{8,}:[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})/g, '<redacted>');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function safeExternalAgentJobId(job_id) {
  const value = String(job_id || '').trim();
  return /^JOB-EXTAGENT-[A-Z0-9_-]{1,80}$/.test(value) ? value : null;
}

function defaultExternalAgentJobId(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `JOB-EXTAGENT-${stamp}`;
}

function normalizeStatus(status) {
  const value = String(status || '').trim();
  return JOB_STATUSES.includes(value) ? value : null;
}

function jobDir(rootDir) {
  return path.join(rootDir, JOB_DIR);
}

function jobPath(rootDir, job_id) {
  return path.join(jobDir(rootDir), `${safeExternalAgentJobId(job_id)}.json`);
}

function summarizeExternalAgentJob(job) {
  return {
    ok: true,
    stage: 'external_agent_job_status',
    reason: null,
    job_id: job.job_id,
    status: job.status,
    approval_id: job.approval_id || null,
    gateway_type: job.gateway_type || null,
    gateway_name: job.gateway_name || null,
    sandbox_root: job.sandbox_root || null,
    candidate_patch_path: job.candidate_patch_path || null,
    command_type: job.command_type || 'external_agent_candidate_patch',
    task_preview: oneLine(job.task_preview || ''),
    started_at: job.started_at || null,
    updated_at: job.updated_at || null,
    finished_at: job.finished_at || null,
    exit_code: Number.isInteger(job.exit_code) ? job.exit_code : null,
    stdout_preview: oneLine(job.stdout_preview || ''),
    stderr_preview: oneLine(job.stderr_preview || ''),
    execution_connected: job.execution_connected === true,
    real_gateway_process_started: job.real_gateway_process_started === true,
    abort_requested: job.abort_requested === true,
    commands_executed: Array.isArray(job.commands_executed) ? job.commands_executed.map((entry) => oneLine(entry, 160)).slice(0, 5) : [],
    files_modified: Array.isArray(job.files_modified) ? job.files_modified.slice(0, 20) : [],
    repository_files_modified: Array.isArray(job.repository_files_modified) ? job.repository_files_modified.slice(0, 20) : [],
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: job.next_action || null
  };
}

function writeExternalAgentJob(rootDir, job) {
  const id = safeExternalAgentJobId(job.job_id);
  if (!id) return { ok: false, reason: 'job_id_not_allowed' };
  const status = normalizeStatus(job.status);
  if (!status) return { ok: false, reason: 'job_status_not_allowed' };
  const now = new Date().toISOString();
  const record = {
    job_id: id,
    status,
    approval_id: job.approval_id || null,
    gateway_type: job.gateway_type || null,
    gateway_name: job.gateway_name || null,
    sandbox_root: job.sandbox_root || null,
    candidate_patch_path: job.candidate_patch_path || null,
    command_type: 'external_agent_candidate_patch',
    task_preview: oneLine(job.task_preview || ''),
    started_at: job.started_at || now,
    updated_at: job.updated_at || now,
    finished_at: job.finished_at || null,
    exit_code: Number.isInteger(job.exit_code) ? job.exit_code : null,
    stdout_preview: oneLine(job.stdout_preview || ''),
    stderr_preview: oneLine(job.stderr_preview || ''),
    execution_connected: job.execution_connected === true,
    real_gateway_process_started: job.real_gateway_process_started === true,
    abort_requested: job.abort_requested === true,
    commands_executed: Array.isArray(job.commands_executed) ? job.commands_executed.map((entry) => oneLine(entry, 160)).slice(0, 5) : [],
    files_modified: Array.isArray(job.files_modified) ? job.files_modified.slice(0, 20) : [],
    repository_files_modified: [],
    apply_allowed: false,
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: job.next_action || null
  };
  fs.mkdirSync(jobDir(rootDir), { recursive: true });
  fs.writeFileSync(jobPath(rootDir, id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { ok: true, reason: null, job: record, summary: summarizeExternalAgentJob(record) };
}

function readExternalAgentJob(rootDir, job_id) {
  const id = safeExternalAgentJobId(job_id);
  if (!id) return null;
  const filePath = jobPath(rootDir, id);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listExternalAgentJobs(rootDir, { limit = 10 } = {}) {
  const dir = jobDir(rootDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, Math.max(1, Math.min(25, limit)))
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function externalAgentJobStatus({ rootDir = process.cwd(), job_id, limit = 10 } = {}) {
  if (job_id) {
    const job = readExternalAgentJob(rootDir, job_id);
    if (!job) return { ok: false, stage: 'external_agent_job_status', reason: 'job_not_found', job_id: safeExternalAgentJobId(job_id), jobs: [], execution_connected: false, commands_executed: [], files_modified: [], deploy_performed: false, migration_performed: false };
    return { ...summarizeExternalAgentJob(job), jobs: [summarizeExternalAgentJob(job)] };
  }
  return {
    ok: true,
    stage: 'external_agent_job_status',
    reason: null,
    job_id: null,
    jobs: listExternalAgentJobs(rootDir, { limit }).map(summarizeExternalAgentJob),
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    deploy_performed: false,
    migration_performed: false,
    next_action: 'inspect_external_agent_job_or_continue_operator_flow'
  };
}

function abortExternalAgentJob({ rootDir = process.cwd(), job_id, now = new Date() } = {}) {
  const job = readExternalAgentJob(rootDir, job_id);
  if (!job) return { ok: false, stage: 'external_agent_job_abort', reason: 'job_not_found', job_id: safeExternalAgentJobId(job_id), execution_connected: false, abort_requested: false, commands_executed: [], files_modified: [], deploy_performed: false, migration_performed: false };
  if (job.status !== 'running') return { ...summarizeExternalAgentJob(job), ok: false, stage: 'external_agent_job_abort', reason: 'job_not_running', abort_requested: job.abort_requested === true, execution_connected: false, commands_executed: [], files_modified: [], deploy_performed: false, migration_performed: false, next_action: 'inspect_external_agent_job_status' };
  const updated = {
    ...job,
    status: 'aborted',
    abort_requested: true,
    updated_at: now.toISOString(),
    finished_at: now.toISOString(),
    exit_code: null,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    next_action: 'inspect_external_agent_job_status_then_cleanup_sandbox'
  };
  const written = writeExternalAgentJob(rootDir, updated);
  return { ...written.summary, ok: true, stage: 'external_agent_job_abort', reason: null, abort_requested: true };
}

module.exports = {
  JOB_STATUSES,
  defaultExternalAgentJobId,
  safeExternalAgentJobId,
  writeExternalAgentJob,
  readExternalAgentJob,
  listExternalAgentJobs,
  externalAgentJobStatus,
  abortExternalAgentJob,
  summarizeExternalAgentJob
};
