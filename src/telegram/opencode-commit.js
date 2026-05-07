const { spawnSync } = require('node:child_process');
const { readApproval } = require('../ralph/approval-manager');
const { APPROVAL_TYPES, APPROVAL_STATUSES } = require('../ralph/types');
const { calculateDiffHash } = require('../ralph/hash');
const { changedFilesFromTouched, gitChangedFiles } = require('./opencode-apply');

const DEFAULT_TIMEOUT_MS = 30000;
const SECRET_LIKE_PATTERN = /(?:\b\d{8,}:[A-Za-z0-9_-]{20,}\b|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})/g;

function oneLine(value, maxLength = 600) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SECRET_LIKE_PATTERN, '<redacted>');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function blocked(reason, extra = {}) {
  const now = new Date().toISOString();
  return {
    ok: false,
    stage: 'opencode_commit',
    reason,
    approval_id: extra.approval_id || null,
    source_approval_id: extra.source_approval_id || null,
    patch_hash: extra.patch_hash || null,
    commit_message: extra.commit_message || null,
    command: 'git commit',
    exit_code: null,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    commit_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    git_status_files: [],
    commit_sha: null,
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_opencode_commit_preflight_failure'
  };
}

function opencodeCommitPreflight({ rootDir = process.cwd(), approval_id } = {}) {
  if (!approval_id) return blocked('approval_id_required');
  let approval;
  try {
    approval = readApproval(rootDir, approval_id);
  } catch {
    return blocked('approval_not_found', { approval_id });
  }

  const base = {
    approval_id,
    source_approval_id: approval.source_approval_id || null,
    patch_hash: approval.patch_hash || null,
    commit_message: approval.commit_message || null
  };
  if (approval.status !== APPROVAL_STATUSES.APPROVED) return blocked('approval_not_approved', base);
  if (approval.approval_type !== APPROVAL_TYPES.DIFF) return blocked('approval_type_not_diff', base);
  if (approval.requested_action !== 'opencode_candidate_patch_commit') return blocked('requested_action_not_commit', base);
  if (!approval.commit_message) return blocked('commit_message_required', base);

  const currentDiffHash = calculateDiffHash(rootDir);
  if (currentDiffHash !== approval.pre_exec_diff_hash) {
    return blocked('pre_commit_diff_hash_mismatch', { ...base, expected_diff_hash: approval.pre_exec_diff_hash, actual_diff_hash: currentDiffHash });
  }

  const repositoryFilesModified = changedFilesFromTouched(approval.files_touched || [], rootDir);
  if (repositoryFilesModified.length === 0) return blocked('applied_files_missing', base);

  return {
    ok: true,
    stage: 'opencode_commit_preflight',
    reason: null,
    approval_id,
    source_approval_id: approval.source_approval_id,
    patch_hash: approval.patch_hash,
    commit_message: approval.commit_message,
    pre_commit_diff_hash: approval.pre_exec_diff_hash,
    files_touched: approval.files_touched || [],
    repository_files_modified: repositoryFilesModified,
    git_status_files: gitChangedFiles(rootDir),
    commit_allowed: true,
    execution_connected: false,
    commands_executed: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'git_commit_allowed'
  };
}

function currentHead(rootDir) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8', maxBuffer: 1024 * 8 });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function commitOpenCodeAppliedPatch({ rootDir = process.cwd(), approval_id, timeout_ms = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  const preflight = opencodeCommitPreflight({ rootDir, approval_id });
  if (!preflight.ok) return { ...preflight, stage: 'opencode_commit' };

  const startedAt = now().toISOString();
  const add = spawnSync('git', ['add', '--', ...preflight.repository_files_modified], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 64
  });
  if (add.status !== 0 || add.error) {
    const finishedAt = now().toISOString();
    return {
      ok: false,
      stage: 'opencode_commit',
      reason: add.error?.code === 'ETIMEDOUT' ? 'git_add_timeout' : 'git_add_failed',
      preflight,
      approval_id: preflight.approval_id,
      source_approval_id: preflight.source_approval_id,
      patch_hash: preflight.patch_hash,
      commit_message: preflight.commit_message,
      command: 'git add',
      exit_code: typeof add.status === 'number' ? add.status : null,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs(startedAt, finishedAt),
      stdout_preview: oneLine(add.stdout),
      stderr_preview: oneLine(add.stderr || add.error?.message || ''),
      commit_allowed: true,
      execution_connected: true,
      commands_executed: ['git add -- <approved_files>'],
      files_modified: preflight.repository_files_modified,
      repository_files_modified: preflight.repository_files_modified,
      git_status_files: gitChangedFiles(rootDir),
      commit_sha: null,
      commit_created: false,
      push_performed: false,
      deploy_performed: false,
      migration_performed: false,
      next_action: 'fix_git_add_failure'
    };
  }

  const commit = spawnSync('git', ['-c', 'user.email=ralph@example.local', '-c', 'user.name=Ralph', 'commit', '-m', preflight.commit_message], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 128
  });
  const finishedAt = now().toISOString();
  const exitCode = typeof commit.status === 'number' ? commit.status : null;
  const timedOut = commit.error && commit.error.code === 'ETIMEDOUT';
  const ok = exitCode === 0 && !timedOut;
  const commitSha = ok ? currentHead(rootDir) : null;

  return {
    ok,
    stage: 'opencode_commit',
    reason: ok ? null : timedOut ? 'git_commit_timeout' : 'git_commit_failed',
    preflight,
    approval_id: preflight.approval_id,
    source_approval_id: preflight.source_approval_id,
    patch_hash: preflight.patch_hash,
    commit_message: preflight.commit_message,
    command: 'git commit',
    exit_code: exitCode,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    stdout_preview: oneLine(commit.stdout),
    stderr_preview: oneLine(commit.stderr || commit.error?.message || ''),
    commit_allowed: true,
    execution_connected: true,
    commands_executed: ['git add -- <approved_files>', 'git commit -m <approved_commit_message>'],
    files_modified: preflight.repository_files_modified,
    repository_files_modified: preflight.repository_files_modified,
    git_status_files: gitChangedFiles(rootDir),
    commit_sha: commitSha,
    commit_created: ok,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: ok ? 'review_commit_then_push_only_with_operator_approval' : 'fix_git_commit_failure'
  };
}

module.exports = { opencodeCommitPreflight, commitOpenCodeAppliedPatch, oneLine };
