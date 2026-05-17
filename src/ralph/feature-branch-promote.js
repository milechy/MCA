const { spawnSync } = require('node:child_process');

const PROMOTE_VERSION = 'feature_branch_promote_v0_1';
const DEFAULT_TIMEOUT_MS = 10000;
const SAFE_BRANCH = /^[A-Za-z0-9_./-]+$/;
const SAFE_SHA = /^[a-f0-9]{7,40}$/;

function oneLine(value, maxLength = 240) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeBranchSegment(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_./-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function featureBranchForStory(storyId) {
  const segment = normalizeBranchSegment(storyId);
  if (!segment) return null;
  return `auto/${segment}`;
}

function currentBranch(rootDir, { spawn = spawnSync, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const r = spawn('git', ['branch', '--show-current'], { cwd: rootDir, encoding: 'utf8', timeout });
  if (r.status !== 0) return null;
  const out = String(r.stdout || '').trim();
  return out || null;
}

function revParse(rootDir, ref, { spawn = spawnSync, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const r = spawn('git', ['rev-parse', ref], { cwd: rootDir, encoding: 'utf8', timeout });
  if (r.status !== 0) return null;
  const sha = String(r.stdout || '').trim();
  return SAFE_SHA.test(sha) ? sha : null;
}

function refExists(rootDir, ref, { spawn = spawnSync, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const r = spawn('git', ['show-ref', '--verify', '--quiet', ref], { cwd: rootDir, timeout });
  return r.status === 0;
}

// Promote a just-created commit on the trunk branch onto a per-story feature
// branch, leaving the trunk pointer where it was before the commit. This is
// the post-commit step that lets the autonomous loop open a PR (head=feature,
// base=trunk) instead of pushing to trunk directly.
//
// Pre-condition: HEAD is on the trunk branch, and HEAD == commit_sha (the
// just-created commit, whose parent is the prior trunk tip).
//
// Operations (all local, no network):
//   1) Validate inputs.
//   2) parent_sha = commit_sha's parent (`commit_sha^`).
//   3) `git branch <feature_branch> <commit_sha>` (creates ref pointing at
//       the new commit). Refuses if the feature branch already exists with
//       a different SHA (would otherwise lose work).
//   4) `git reset --hard <parent_sha>` (rewinds trunk by one commit).
//
// Post-condition:
//   - <trunk_branch> points at parent_sha (working tree clean).
//   - <feature_branch> points at commit_sha (off-graph from trunk for now;
//     PUSH will publish it).
//
// The function never operates on network refs and never force-updates the
// feature branch — it returns a clean failure if the branch already exists.
function promoteCommitToFeatureBranch({
  rootDir,
  story_id,
  commit_sha,
  trunk_branch,
  feature_branch,
  spawn = spawnSync,
  timeout = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!rootDir) return { ok: false, version: PROMOTE_VERSION, reason: 'root_dir_required' };

  const branchName = feature_branch || (story_id ? featureBranchForStory(story_id) : null);
  if (!branchName || !SAFE_BRANCH.test(branchName)) {
    return { ok: false, version: PROMOTE_VERSION, reason: 'feature_branch_invalid', feature_branch: branchName || null };
  }

  if (!commit_sha || !SAFE_SHA.test(commit_sha)) {
    return { ok: false, version: PROMOTE_VERSION, reason: 'commit_sha_invalid', commit_sha: commit_sha || null };
  }

  if (!trunk_branch || !SAFE_BRANCH.test(trunk_branch)) {
    return { ok: false, version: PROMOTE_VERSION, reason: 'trunk_branch_invalid', trunk_branch: trunk_branch || null };
  }

  const head = revParse(rootDir, 'HEAD', { spawn, timeout });
  if (!head) return { ok: false, version: PROMOTE_VERSION, reason: 'head_unreadable' };
  if (head !== commit_sha) return { ok: false, version: PROMOTE_VERSION, reason: 'head_is_not_commit_sha', head, commit_sha };

  const current = currentBranch(rootDir, { spawn, timeout });
  if (current !== trunk_branch) {
    return { ok: false, version: PROMOTE_VERSION, reason: 'current_branch_is_not_trunk', current_branch: current, trunk_branch };
  }

  const parentSha = revParse(rootDir, `${commit_sha}^`, { spawn, timeout });
  if (!parentSha) return { ok: false, version: PROMOTE_VERSION, reason: 'parent_sha_unreadable', commit_sha };

  // Refuse to overwrite an existing feature branch that points elsewhere.
  if (refExists(rootDir, `refs/heads/${branchName}`, { spawn, timeout })) {
    const existing = revParse(rootDir, branchName, { spawn, timeout });
    if (existing && existing !== commit_sha) {
      return {
        ok: false,
        version: PROMOTE_VERSION,
        reason: 'feature_branch_already_exists',
        feature_branch: branchName,
        existing_sha: existing,
        commit_sha
      };
    }
    // Branch already at the right SHA — idempotent path; proceed to reset trunk.
  } else {
    const branch = spawn('git', ['branch', branchName, commit_sha], { cwd: rootDir, encoding: 'utf8', timeout });
    if (branch.status !== 0) {
      return {
        ok: false,
        version: PROMOTE_VERSION,
        reason: 'git_branch_create_failed',
        feature_branch: branchName,
        stderr_preview: oneLine(branch.stderr || ''),
        exit_code: typeof branch.status === 'number' ? branch.status : null
      };
    }
  }

  const reset = spawn('git', ['reset', '--hard', parentSha], { cwd: rootDir, encoding: 'utf8', timeout });
  if (reset.status !== 0) {
    return {
      ok: false,
      version: PROMOTE_VERSION,
      reason: 'git_reset_trunk_failed',
      feature_branch: branchName,
      trunk_branch,
      parent_sha: parentSha,
      stderr_preview: oneLine(reset.stderr || ''),
      exit_code: typeof reset.status === 'number' ? reset.status : null
    };
  }

  return {
    ok: true,
    version: PROMOTE_VERSION,
    reason: null,
    feature_branch: branchName,
    trunk_branch,
    commit_sha,
    parent_sha: parentSha,
    commands_executed: [
      `git branch ${branchName} <commit_sha>`,
      `git reset --hard <parent_sha>`
    ],
    repository_files_modified: [],
    push_performed: false,
    deploy_performed: false,
    migration_performed: false,
    next_action: 'push_feature_branch_to_origin_for_pr'
  };
}

module.exports = {
  PROMOTE_VERSION,
  SAFE_BRANCH,
  SAFE_SHA,
  normalizeBranchSegment,
  featureBranchForStory,
  currentBranch,
  revParse,
  refExists,
  promoteCommitToFeatureBranch
};
