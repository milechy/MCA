// Phase 2 #3b: requested_paths coverage gate.
//
// The Phase 2 #3 smoke test (PR #137) and Phase 2 #3a dogfood (PR #139)
// both revealed the same defect class: Kimi K2.6 produces partial
// implementations when a story has multiple requested_paths — typically
// touching only the first "new file" and skipping the rest (other new
// files, modifications of existing files). Downstream gates can't catch
// this because they don't know what was supposed to be touched; they only
// know the current tree state. So a partial implementation passes the
// gate suite (since there's no test for the missing pieces) and reaches
// COMMIT → PUSH → PR with an incomplete diff.
//
// This module adds a check that runs right after APPLY: did the candidate
// patch (now applied to the worktree-isolated working tree) touch every
// path declared in story.requested_paths? If not, fail with a specific
// reason so the autonomous-loop can route to FIX_LOOP with a focused
// repair_instruction listing exactly the missing paths.
//
// Inputs:
//   - story.requested_paths: the declared scope
//   - apply_result.repository_files_modified: what the patch actually
//     touched, as reported by applyOpenCodeCandidatePatch
//   - Optional fallback: git status --porcelain, for the case where the
//     apply_result is null (story was apply-deferred) or its
//     repository_files_modified field is empty
//
// Output:
//   - { ok, reason, requested_paths, touched_paths, missing_paths,
//       extra_touched_paths, fallback_used }
//
// Notes:
//   - "missing_paths" is the actionable list: paths declared but not touched
//   - "extra_touched_paths" is informational: paths touched but NOT declared.
//     We DO NOT fail on extras here because the autonomous-loop's existing
//     candidate_patch_unrequested_path preflight already catches forbidden
//     extras; this gate's purpose is the OPPOSITE — catching omissions.
//   - All paths are normalized to forward-slash, relative, no leading "./"

const { spawnSync } = require('node:child_process');

const COVERAGE_VERSION = 'requested_paths_coverage_v0_1';

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function uniqueSorted(items) {
  return Array.from(new Set(items)).filter(Boolean).sort();
}

// Read git status --porcelain output and extract touched paths.
// Handles renames (' -> ') correctly by returning the destination path.
function gitStatusTouched(rootDir, { spawn = spawnSync, timeout = 5000 } = {}) {
  // -uall: show each untracked file individually instead of summarising
  // untracked directories. Without this, `git status --porcelain` would
  // report a fresh "scripts/" rather than "scripts/a.sh", which would
  // make the coverage check report `requested_paths_coverage_incomplete`
  // even though the file IS there. The Phase 2 #3b smoke tests caught
  // this regression on the first run.
  const result = spawn('git', ['status', '--porcelain', '-uall'], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout,
    maxBuffer: 1024 * 64
  });
  if (result.status !== 0) return null;
  const out = String(result.stdout || '');
  const touched = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // Format: "XY path" or "XY oldpath -> newpath" (rename/copy)
    // X and Y are status chars, then space, then path. We skip the 2 status
    // chars + space, then handle renames.
    const body = line.length > 3 ? line.slice(3) : '';
    if (!body) continue;
    const arrow = body.indexOf(' -> ');
    const filePath = arrow >= 0 ? body.slice(arrow + 4) : body;
    touched.push(normalizePath(filePath));
  }
  return uniqueSorted(touched);
}

function checkRequestedPathsCoverage({
  rootDir,
  story = {},
  apply_result = null,
  spawn = spawnSync,
  timeout = 5000
} = {}) {
  const requested = Array.isArray(story.requested_paths) ? story.requested_paths.map(normalizePath).filter(Boolean) : [];

  // Trivially ok: nothing was requested.
  if (requested.length === 0) {
    return {
      ok: true,
      version: COVERAGE_VERSION,
      reason: null,
      requested_paths: [],
      touched_paths: [],
      missing_paths: [],
      extra_touched_paths: [],
      fallback_used: false
    };
  }

  // Source 1: apply_result.repository_files_modified (trusted, reported by
  // applyOpenCodeCandidatePatch from the actual `git apply` outcome).
  const fromApply = Array.isArray(apply_result?.repository_files_modified)
    ? apply_result.repository_files_modified.map(normalizePath).filter(Boolean)
    : [];

  // Source 2: git status --porcelain (fallback when apply_result is null
  // OR its repository_files_modified is empty for any reason, e.g. the
  // story was apply-deferred and the patch was rolled into the wired-loop
  // commit path differently).
  let fallbackUsed = false;
  let touched = uniqueSorted(fromApply);
  if (touched.length === 0) {
    const fromGit = gitStatusTouched(rootDir, { spawn, timeout });
    if (fromGit !== null) {
      touched = fromGit;
      fallbackUsed = true;
    }
  }

  const requestedSet = new Set(requested);
  const touchedSet = new Set(touched);
  const missing = requested.filter((p) => !touchedSet.has(p));
  const extra = touched.filter((p) => !requestedSet.has(p));

  return {
    ok: missing.length === 0,
    version: COVERAGE_VERSION,
    reason: missing.length === 0 ? null : 'requested_paths_coverage_incomplete',
    requested_paths: requested,
    touched_paths: touched,
    missing_paths: missing,
    extra_touched_paths: extra,
    fallback_used: fallbackUsed
  };
}

// Build a focused repair instruction for FIX_LOOP that names exactly the
// missing paths and reminds the dispatcher to honour ALL requested paths.
function repairInstructionForMissingPaths(missing_paths = []) {
  const list = (Array.isArray(missing_paths) ? missing_paths : []).filter(Boolean);
  if (list.length === 0) return null;
  return [
    'Previous attempt did not touch these requested paths:',
    ...list.map((p) => `- ${p}`),
    '',
    'Re-run the task and produce changes for ALL of the requested_paths above.',
    'Modify existing files in-place if they already exist; create new files',
    'otherwise. Do not touch any other path.'
  ].join('\n');
}

module.exports = {
  COVERAGE_VERSION,
  normalizePath,
  gitStatusTouched,
  checkRequestedPathsCoverage,
  repairInstructionForMissingPaths
};
