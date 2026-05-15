const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { calculateDiffHash } = require('../ralph/hash');
const { APPROVAL_TYPES, APPROVAL_STATUSES } = require('../ralph/types');
const { readApproval } = require('../ralph/approval-manager');
const { assertSandboxLocalPath } = require('./opencode-sandbox-runner');
const { calculatePatchHash } = require('./opencode-patch-approval');

const APPLY_CHECK_TIMEOUT_MS = 15000;

function oneLine(value, maxLength = 240) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function gitApplyCheck(rootDir, absolutePatchPath, timeout = APPLY_CHECK_TIMEOUT_MS) {
  const result = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', absolutePatchPath], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout,
    maxBuffer: 1024 * 64
  });
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  return {
    ok: !timedOut && result.status === 0,
    timed_out: !!timedOut,
    exit_code: typeof result.status === 'number' ? result.status : null,
    stderr_preview: oneLine(result.stderr || result.error?.message || '', 240)
  };
}

function blocked(reason, extra = {}) {
  return {
    ok: false,
    stage: 'opencode_apply_preflight',
    reason,
    approval_id: extra.approval_id || null,
    patch_hash: extra.patch_hash || null,
    expected_patch_hash: extra.expected_patch_hash || null,
    pre_apply_diff_hash: extra.pre_apply_diff_hash || null,
    expected_pre_apply_diff_hash: extra.expected_pre_apply_diff_hash || null,
    pre_apply_diff_hash_changed: !!extra.pre_apply_diff_hash_changed,
    apply_check_ok: extra.apply_check_ok === undefined ? null : !!extra.apply_check_ok,
    apply_check_stderr_preview: extra.apply_check_stderr_preview || null,
    candidate_patch_path: extra.candidate_patch_path || null,
    sandbox_root: extra.sandbox_root || null,
    apply_allowed: false,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'fix_apply_preflight_failure'
  };
}

function approvedOpenCodeApplyPreflight({ rootDir = process.cwd(), approval_id, patch_hash } = {}) {
  if (!approval_id) return blocked('approval_id_required');
  let approval;
  try {
    approval = readApproval(rootDir, approval_id);
  } catch {
    return blocked('approval_not_found', { approval_id });
  }

  const base = {
    approval_id,
    candidate_patch_path: approval.candidate_patch_path || null,
    sandbox_root: approval.sandbox_root || null,
    expected_patch_hash: approval.patch_hash || null,
    patch_hash: patch_hash || null,
    expected_pre_apply_diff_hash: approval.pre_exec_diff_hash || null,
    pre_apply_diff_hash: calculateDiffHash(rootDir)
  };

  if (approval.approval_type !== APPROVAL_TYPES.DIFF) return blocked('approval_type_not_diff', base);
  if (approval.status !== APPROVAL_STATUSES.APPROVED) return blocked('approval_not_approved', base);
  if (new Date(approval.expires_at).getTime() < Date.now()) return blocked('approval_expired', base);
  if (approval.requested_action !== 'opencode_candidate_patch_apply') return blocked('requested_action_not_apply', base);
  if (approval.apply_allowed !== false) return blocked('approval_apply_must_be_disabled_until_preflight', base);
  if (approval.execution_connected !== false) return blocked('approval_execution_must_be_disconnected', base);
  if (approval.risk?.score >= 5) return blocked('approval_risk_blocked', base);
  if (!approval.candidate_patch_path || !approval.sandbox_root) return blocked('candidate_patch_required', base);

  const absolutePatchPath = path.isAbsolute(approval.candidate_patch_path)
    ? approval.candidate_patch_path
    : path.join(rootDir, approval.candidate_patch_path);
  if (!assertSandboxLocalPath(rootDir, approval.sandbox_root, absolutePatchPath)) return blocked('candidate_patch_path_not_allowed', base);
  if (!fs.existsSync(absolutePatchPath)) return blocked('candidate_patch_missing', base);

  const currentPatchHash = calculatePatchHash(rootDir, approval);
  const suppliedPatchHash = patch_hash || currentPatchHash;
  if (!approval.patch_hash || suppliedPatchHash !== approval.patch_hash || currentPatchHash !== approval.patch_hash) {
    return blocked('patch_hash_mismatch', { ...base, patch_hash: suppliedPatchHash, expected_patch_hash: approval.patch_hash });
  }

  // Phase 1 #9 (I): replace the strict pre_apply_diff_hash equality check
  // with a semantic "does this patch still apply cleanly?" test. The original
  // hash equality was fundamentally fragile under the autonomous loop:
  // between DIFF-approval creation and APPLY execution, other serialized
  // stories' COMMIT phases legitimately advance main's tree, drifting the
  // diff hash even though our own patch is still applicable. Bug F was
  // exactly that false positive — pre_apply_diff_hash_mismatch blocking
  // stories whose patches would have applied cleanly.
  //
  // The replacement: run `git apply --check` against the live working tree.
  // If the patch would apply, we proceed; if not, we surface a descriptive
  // candidate_patch_does_not_apply_cleanly with the git stderr preview.
  //
  // We still record `pre_apply_diff_hash` and `expected_pre_apply_diff_hash`
  // for observability, plus a new `pre_apply_diff_hash_changed` boolean so
  // operators can see at a glance whether main moved (informational, never
  // a blocker on its own).
  const currentDiffHash = calculateDiffHash(rootDir);
  const preApplyDiffHashChanged = approval.pre_exec_diff_hash !== currentDiffHash;

  const applyCheck = gitApplyCheck(rootDir, absolutePatchPath);
  if (!applyCheck.ok) {
    return blocked('candidate_patch_does_not_apply_cleanly', {
      ...base,
      pre_apply_diff_hash: currentDiffHash,
      pre_apply_diff_hash_changed: preApplyDiffHashChanged,
      apply_check_ok: false,
      apply_check_stderr_preview: applyCheck.stderr_preview
    });
  }

  return {
    ok: true,
    stage: 'opencode_apply_preflight',
    reason: null,
    approval_id,
    approval_type: approval.approval_type,
    status: approval.status,
    requested_action: approval.requested_action,
    candidate_patch_path: approval.candidate_patch_path,
    sandbox_root: approval.sandbox_root,
    patch_hash: approval.patch_hash,
    pre_apply_diff_hash: currentDiffHash,
    expected_pre_apply_diff_hash: approval.pre_exec_diff_hash || null,
    pre_apply_diff_hash_changed: preApplyDiffHashChanged,
    apply_check_ok: true,
    apply_check_stderr_preview: null,
    files_touched: approval.files_touched || [],
    risk: approval.risk,
    apply_allowed: true,
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    commit_created: false,
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'apply_candidate_patch_with_same_approval_and_patch_hash'
  };
}

module.exports = { approvedOpenCodeApplyPreflight };
