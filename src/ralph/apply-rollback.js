const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROLLBACK_VERSION = 'apply_rollback_v0_1';
const MAX_PATHS = 50;
const DEFAULT_TIMEOUT_MS = 10000;
const SAFE_REPO_PATH = /^[A-Za-z0-9_./-]+$/;

function oneLine(value, maxLength = 240) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizePath(value) {
  const v = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!v || v.startsWith('/') || v.includes('..') || /\0/.test(v)) return null;
  if (!SAFE_REPO_PATH.test(v)) return null;
  return v;
}

function gatherPathsFromApplyResult(applyResult, requested_paths) {
  const fromApply = []
    .concat(Array.isArray(applyResult && applyResult.repository_files_modified) ? applyResult.repository_files_modified : [])
    .concat(Array.isArray(applyResult && applyResult.files_modified) ? applyResult.files_modified : []);
  const requested = (Array.isArray(requested_paths) ? requested_paths : []).map((p) => normalizePath(p)).filter(Boolean);
  const requestedSet = new Set(requested);
  const out = [];
  const seen = new Set();
  for (const raw of fromApply) {
    const p = normalizePath(raw);
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    // Strict scope: only roll back paths the story was authorized to touch.
    if (requestedSet.size > 0 && !requestedSet.has(p)) continue;
    out.push(p);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

function isTrackedAtHead(rootDir, p, { spawn = spawnSync, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const r = spawn('git', ['ls-files', '--error-unmatch', '--', p], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return r.status === 0;
}

function fileExistsInWorktree(rootDir, p) {
  try { return fs.statSync(path.join(rootDir, p)).isFile(); }
  catch { return false; }
}

function workingTreeIsClean(rootDir, { spawn = spawnSync, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const r = spawn('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: rootDir, encoding: 'utf8', timeout });
  if (r.status !== 0) return { ok: false, reason: 'git_status_failed', stderr: oneLine(r.stderr) };
  const dirty = String(r.stdout || '').trim();
  return { ok: true, clean: dirty.length === 0, porcelain_preview: oneLine(dirty, 600) };
}

function rollbackAppliedFiles({ rootDir = process.cwd(), apply_result, requested_paths, spawn = spawnSync, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  if (!rootDir) return { ok: false, reason: 'root_dir_required' };
  const targets = gatherPathsFromApplyResult(apply_result, requested_paths);
  if (targets.length === 0) {
    return { ok: true, version: ROLLBACK_VERSION, paths: [], actions: [], reason: 'no_paths_to_rollback', wired_to_runtime: true };
  }

  const actions = [];
  for (const p of targets) {
    // Resolve absolute path and guard against any path escaping rootDir.
    const abs = path.resolve(rootDir, p);
    if (!abs.startsWith(path.resolve(rootDir) + path.sep) && abs !== path.resolve(rootDir)) {
      actions.push({ path: p, action: 'refused', reason: 'path_escapes_root_dir' });
      continue;
    }
    if (isTrackedAtHead(rootDir, p, { spawn, timeout })) {
      const r = spawn('git', ['checkout', '--', p], { cwd: rootDir, encoding: 'utf8', timeout });
      actions.push({
        path: p,
        action: 'git_checkout',
        ok: r.status === 0,
        stderr_preview: r.status === 0 ? null : oneLine(r.stderr, 240)
      });
    } else if (fileExistsInWorktree(rootDir, p)) {
      try {
        fs.unlinkSync(abs);
        actions.push({ path: p, action: 'unlink', ok: true });
      } catch (e) {
        actions.push({ path: p, action: 'unlink', ok: false, error: oneLine(e && e.message ? e.message : String(e), 240) });
      }
    } else {
      actions.push({ path: p, action: 'noop', reason: 'not_tracked_and_not_present' });
    }
  }

  const verify = workingTreeIsClean(rootDir, { spawn, timeout });
  const allOk = actions.every((a) => a.ok !== false);
  return {
    ok: allOk && verify.ok === true && verify.clean === true,
    version: ROLLBACK_VERSION,
    paths: targets,
    actions,
    verify,
    reason: !allOk ? 'rollback_action_failed' : (verify.clean === false ? 'working_tree_still_dirty' : null),
    wired_to_runtime: true,
    repository_files_modified: targets,
    execution_connected: true,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false
  };
}

module.exports = {
  ROLLBACK_VERSION,
  MAX_PATHS,
  normalizePath,
  gatherPathsFromApplyResult,
  isTrackedAtHead,
  fileExistsInWorktree,
  workingTreeIsClean,
  rollbackAppliedFiles
};
