const { spawnSync } = require('node:child_process');
const { readApproval } = require('../ralph/approval-manager');
const { calculatePatchHash } = require('./opencode-patch-approval');
const { changedFilesFromTouched, gitChangedFiles } = require('./opencode-apply');

const DEFAULT_TIMEOUT_MS = 180000;
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
    stage: 'opencode_gates',
    reason,
    approval_id: extra.approval_id || null,
    patch_hash: extra.patch_hash || null,
    candidate_patch_path: extra.candidate_patch_path || null,
    command: 'scripts/gates/run-all.sh',
    exit_code: null,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    execution_connected: false,
    gates_started: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_opencode_gates_preflight_failure'
  };
}

function opencodeGatesPreflight({ rootDir = process.cwd(), approval_id, patch_hash } = {}) {
  if (!approval_id) return blocked('approval_id_required');
  let approval;
  try {
    approval = readApproval(rootDir, approval_id);
  } catch {
    return blocked('approval_not_found', { approval_id });
  }

  const base = {
    approval_id,
    patch_hash: patch_hash || null,
    candidate_patch_path: approval.candidate_patch_path || null
  };
  if (approval.status !== 'approved') return blocked('approval_not_approved', base);
  if (approval.requested_action !== 'opencode_candidate_patch_apply') return blocked('requested_action_not_apply', base);
  if (!approval.patch_hash || patch_hash !== approval.patch_hash) return blocked('patch_hash_mismatch', { ...base, patch_hash, expected_patch_hash: approval.patch_hash });
  if (calculatePatchHash(rootDir, approval) !== approval.patch_hash) return blocked('candidate_patch_hash_mismatch', base);

  const repositoryFilesModified = changedFilesFromTouched(approval.files_touched || [], rootDir);
  if (repositoryFilesModified.length === 0) return blocked('applied_files_missing', base);

  return {
    ok: true,
    stage: 'opencode_gates_preflight',
    reason: null,
    approval_id,
    patch_hash: approval.patch_hash,
    candidate_patch_path: approval.candidate_patch_path,
    files_touched: approval.files_touched || [],
    repository_files_modified: repositoryFilesModified,
    git_status_files: gitChangedFiles(rootDir),
    command: 'scripts/gates/run-all.sh',
    execution_connected: false,
    commands_executed: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'run_local_gates_for_applied_patch'
  };
}

function runOpenCodeAppliedPatchGates({ rootDir = process.cwd(), approval_id, patch_hash, timeout_ms = DEFAULT_TIMEOUT_MS, now = () => new Date() } = {}) {
  const preflight = opencodeGatesPreflight({ rootDir, approval_id, patch_hash });
  if (!preflight.ok) return { ...preflight, stage: 'opencode_gates' };

  const startedAt = now().toISOString();
  const result = spawnSync('scripts/gates/run-all.sh', [], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: timeout_ms,
    maxBuffer: 1024 * 1024
  });
  const finishedAt = now().toISOString();
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  const ok = exitCode === 0 && !timedOut;
  const repositoryFilesModified = changedFilesFromTouched(preflight.files_touched, rootDir);
  // Phase 1 #7 fix: scripts/gates/run-all.sh now emits a structured
  // [gate] FAILED_GATE=<name> line when any sub-gate fails. Parse it so the
  // wired loop's failure summary can report failed_gate by name rather than
  // null, and operator dashboards can group gate failures by gate.
  const failedGate = ok ? null : parseFailedGateName(result.stdout, result.stderr);

  return {
    ok,
    stage: 'opencode_gates',
    reason: ok ? null : timedOut ? 'opencode_gates_timeout' : 'opencode_gates_failed',
    failed_gate: failedGate,
    preflight,
    approval_id: preflight.approval_id,
    patch_hash: preflight.patch_hash,
    candidate_patch_path: preflight.candidate_patch_path,
    command: 'scripts/gates/run-all.sh',
    exit_code: exitCode,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    stdout_preview: oneLine(result.stdout),
    stderr_preview: oneLine(result.stderr || result.error?.message || ''),
    execution_connected: true,
    gates_started: true,
    commands_executed: ['scripts/gates/run-all.sh'],
    files_modified: repositoryFilesModified,
    repository_files_modified: repositoryFilesModified,
    git_status_files: gitChangedFiles(rootDir),
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: ok ? 'review_diff_then_commit_with_operator_approval' : 'fix_gates_failure_before_commit'
  };
}

// Real gate names are kebab-case (pre-secret-scan, ralph-tests, supabase-local,
// playwright-e2e, etc.). Requiring at least one hyphen rejects accidental
// shell-tokens like "rm" if someone tried to slip them through FAILED_GATE=.
// The downstream consumer just renders the name into JSON; shell-quoting is
// not required, but the regex stays narrow so any future caller cannot use it
// as a free-form metadata channel.
const SAFE_GATE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+$/;
function parseFailedGateName(stdout, stderr) {
  for (const stream of [stdout, stderr]) {
    if (!stream) continue;
    const m = String(stream).match(/\[gate\]\s*FAILED_GATE=([A-Za-z0-9_.-]+)/);
    if (m && SAFE_GATE_NAME.test(m[1])) return m[1];
  }
  return null;
}

module.exports = { opencodeGatesPreflight, runOpenCodeAppliedPatchGates, parseFailedGateName, oneLine };
