const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { approvedOpenCodeApplyPreflight } = require('./opencode-apply-preflight');

const DEFAULT_TIMEOUT_MS = 30000;
const SECRET_LIKE_PATTERN = /(?:\b\d{8,}:[A-Za-z0-9_-]{20,}\b|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})/g;

function oneLine(value, maxLength = 240) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SECRET_LIKE_PATTERN, '<redacted>');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function parsePorcelainPath(line) {
  const raw = String(line || '');
  if (!raw.trim()) return null;
  const status = raw.slice(0, 2);
  const body = raw.slice(3).trim();
  if (!body) return null;
  if (status.includes('R') || status.includes('C')) {
    const parts = body.split(' -> ');
    return parts[parts.length - 1] || null;
  }
  return body;
}

function gitChangedFiles(rootDir) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: rootDir, encoding: 'utf8', maxBuffer: 1024 * 64 });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map(parsePorcelainPath)
    .filter(Boolean)
    .sort();
}

function blocked(reason, extra = {}) {
  const now = new Date().toISOString();
  return {
    ok: false,
    stage: 'opencode_apply',
    reason,
    approval_id: extra.approval_id || null,
    patch_hash: extra.patch_hash || null,
    candidate_patch_path: extra.candidate_patch_path || null,
    sandbox_root: extra.sandbox_root || null,
    command: 'git apply',
    exit_code: null,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    stdout_preview: '',
    stderr_preview: '',
    apply_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_opencode_apply_failure'
  };
}

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function applyOpenCodeCandidatePatch({ rootDir = process.cwd(), approval_id, patch_hash, timeout_ms = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  const preflight = approvedOpenCodeApplyPreflight({ rootDir, approval_id, patch_hash });
  if (!preflight.ok) return blocked(preflight.reason, preflight);

  const patchPath = path.isAbsolute(preflight.candidate_patch_path)
    ? preflight.candidate_patch_path
    : path.join(rootDir, preflight.candidate_patch_path);
  if (!fs.existsSync(patchPath)) return blocked('candidate_patch_missing', preflight);

  const startedAt = now().toISOString();
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', preflight.candidate_patch_path], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 64
  });
  const finishedAt = now().toISOString();
  const changedFiles = gitChangedFiles(rootDir);
  const filesTouched = preflight.files_touched || [];
  const repositoryFilesModified = changedFiles.filter((file) => filesTouched.includes(file));
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  const ok = exitCode === 0 && !timedOut;

  return {
    ok,
    stage: 'opencode_apply',
    reason: ok ? null : timedOut ? 'opencode_apply_timeout' : 'opencode_apply_failed',
    approval_id: preflight.approval_id,
    patch_hash: preflight.patch_hash,
    pre_apply_diff_hash: preflight.pre_apply_diff_hash,
    candidate_patch_path: preflight.candidate_patch_path,
    sandbox_root: preflight.sandbox_root,
    command: 'git apply',
    exit_code: exitCode,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    stdout_preview: oneLine(result.stdout || ''),
    stderr_preview: oneLine(result.stderr || result.error?.message || ''),
    apply_allowed: true,
    execution_connected: true,
    commands_executed: ['git apply --whitespace=nowarn <candidate_patch_path>'],
    files_modified: repositoryFilesModified,
    repository_files_modified: repositoryFilesModified,
    git_status_files: changedFiles,
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: ok ? 'run_local_gates_then_review_diff' : 'fix_opencode_apply_failure'
  };
}

module.exports = { applyOpenCodeCandidatePatch, gitChangedFiles, parsePorcelainPath };
