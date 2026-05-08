const fs = require('node:fs');
const path = require('node:path');
const { safeJobId, readJob } = require('./opencode-jobs');
const { assertSandboxLocalPath } = require('./opencode-sandbox-runner');

const MAX_LINES = 40;
const MAX_CHARS = 4000;
const MAX_PATCH_CHARS = 6000;

function redact(value) {
  return String(value || '')
    .replace(/(?:\b\d{8,}:[A-Za-z0-9_-]{20,}\b|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})/g, '<redacted>')
    .replace(/TELEGRAM_BOT_TOKEN\s*=\s*\S+/g, 'TELEGRAM_BOT_TOKEN=<redacted>')
    .replace(/BOT_TOKEN\s*=\s*\S+/g, 'BOT_TOKEN=<redacted>');
}

function boundedText(value, maxChars = MAX_CHARS) {
  const text = redact(value).replace(/\r/g, '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function tailLines(value, maxLines = MAX_LINES) {
  const lines = boundedText(value, MAX_CHARS * 2).split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function blocked(reason, extra = {}) {
  return {
    ok: false,
    stage: 'opencode_artifact_retrieval',
    reason,
    job_id: extra.job_id || null,
    artifact_type: extra.artifact_type || null,
    path: null,
    content: '',
    line_count: 0,
    truncated: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_artifact_request'
  };
}

function allowedArtifactPath(rootDir, job, requestedPath) {
  const sandboxRoot = job?.sandbox_root;
  if (!sandboxRoot) return null;
  const absolute = path.resolve(rootDir, requestedPath || path.join(sandboxRoot, 'candidate.patch'));
  if (!assertSandboxLocalPath(rootDir, sandboxRoot, absolute)) return null;
  return absolute;
}

function readBoundedArtifact({ rootDir = process.cwd(), job_id, artifact_type = 'candidate_patch', artifact_path, max_lines = MAX_LINES, max_chars } = {}) {
  const id = safeJobId(job_id);
  if (!id) return blocked('job_id_not_allowed', { job_id, artifact_type });
  const job = readJob(rootDir, id);
  if (!job) return blocked('job_not_found', { job_id: id, artifact_type });

  if (artifact_type === 'stdout') {
    const content = tailLines(job.stdout_preview || '', max_lines);
    return success({ job_id: id, artifact_type, pathValue: null, content, maxChars: max_chars || MAX_CHARS });
  }
  if (artifact_type === 'stderr') {
    const content = tailLines(job.stderr_preview || '', max_lines);
    return success({ job_id: id, artifact_type, pathValue: null, content, maxChars: max_chars || MAX_CHARS });
  }
  if (artifact_type !== 'candidate_patch') return blocked('artifact_type_not_allowed', { job_id: id, artifact_type });

  const absolute = allowedArtifactPath(rootDir, job, artifact_path);
  if (!absolute) return blocked('artifact_path_not_allowed', { job_id: id, artifact_type });
  if (!fs.existsSync(absolute)) return blocked('artifact_missing', { job_id: id, artifact_type });
  const content = tailLines(fs.readFileSync(absolute, 'utf8'), max_lines);
  return success({ job_id: id, artifact_type, pathValue: path.relative(rootDir, absolute).replace(/\\/g, '/'), content, maxChars: max_chars || MAX_PATCH_CHARS });
}

function success({ job_id, artifact_type, pathValue, content, maxChars }) {
  const bounded = boundedText(content, maxChars);
  return {
    ok: true,
    stage: 'opencode_artifact_retrieval',
    reason: null,
    job_id,
    artifact_type,
    path: pathValue,
    content: bounded,
    line_count: bounded ? bounded.split('\n').length : 0,
    truncated: redact(content).length > bounded.length,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    pr_created: false,
    merge_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'continue_operator_review'
  };
}

module.exports = { redact, boundedText, tailLines, readBoundedArtifact };
