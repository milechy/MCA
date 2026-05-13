const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ALLOWED_SANDBOX_PREFIXES = ['.ralph/sandboxes/', '.ralph/tmp/'];
const WORKTREE_SUBDIR = 'worktree';
const DEFAULT_GIT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_DIFF_TIMEOUT_MS = 60 * 1000;

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..') || /\0/.test(normalized)) return null;
  return normalized;
}

function isAllowedSandboxRoot(sandbox_root) {
  const safe = safeRelativePath(sandbox_root);
  if (!safe) return null;
  if (!ALLOWED_SANDBOX_PREFIXES.some((prefix) => safe.startsWith(prefix))) return null;
  return safe;
}

function worktreePathFor(rootDir, sandbox_root) {
  const safe = isAllowedSandboxRoot(sandbox_root);
  if (!safe) return null;
  return {
    relative: `${safe}/${WORKTREE_SUBDIR}`,
    absolute: path.resolve(rootDir, safe, WORKTREE_SUBDIR)
  };
}

function git(args, { rootDir, env = process.env, timeout = DEFAULT_GIT_TIMEOUT_MS, spawn = spawnSync, cwd } = {}) {
  const safeEnv = { PATH: env.PATH || '', HOME: env.HOME || '', GIT_TERMINAL_PROMPT: '0' };
  return spawn('git', args, {
    cwd: cwd || rootDir,
    env: safeEnv,
    encoding: 'utf8',
    timeout,
    maxBuffer: 1024 * 1024
  });
}

function resolveHeadSha(rootDir, { spawn = spawnSync, env = process.env } = {}) {
  const result = git(['rev-parse', 'HEAD'], { rootDir, spawn, env, timeout: 5000 });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function createStoryWorktree({ rootDir, sandbox_root, base_ref = 'HEAD', spawn = spawnSync, env = process.env } = {}) {
  const safe = isAllowedSandboxRoot(sandbox_root);
  if (!safe) return { ok: false, reason: 'worktree_sandbox_root_not_allowed' };
  const paths = worktreePathFor(rootDir, sandbox_root);
  if (!paths) return { ok: false, reason: 'worktree_sandbox_root_not_allowed' };

  fs.mkdirSync(path.dirname(paths.absolute), { recursive: true });

  if (fs.existsSync(paths.absolute)) {
    const cleanup = git(['worktree', 'remove', '--force', paths.absolute], { rootDir, spawn, env });
    if (cleanup.status !== 0 && fs.existsSync(paths.absolute)) {
      try { fs.rmSync(paths.absolute, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  }

  const base = String(base_ref || 'HEAD').trim() || 'HEAD';
  if (!/^[A-Za-z0-9._/\-]+$/.test(base)) return { ok: false, reason: 'worktree_base_ref_invalid' };

  const add = git(['worktree', 'add', '--detach', paths.absolute, base], { rootDir, spawn, env, timeout: 120000 });
  if (add.status !== 0) {
    return {
      ok: false,
      reason: 'worktree_create_failed',
      stderr_preview: String(add.stderr || '').slice(0, 600),
      command_preview: `git worktree add --detach ${paths.relative} ${base}`
    };
  }

  const headSha = resolveHeadSha(paths.absolute, { spawn, env }) || resolveHeadSha(rootDir, { spawn, env });

  return {
    ok: true,
    reason: null,
    worktree_path: paths.relative,
    worktree_absolute: paths.absolute,
    base_sha: headSha,
    command_preview: `git worktree add --detach ${paths.relative} ${base}`
  };
}

function destroyStoryWorktree({ rootDir, sandbox_root, spawn = spawnSync, env = process.env } = {}) {
  const paths = worktreePathFor(rootDir, sandbox_root);
  if (!paths) return { ok: false, reason: 'worktree_sandbox_root_not_allowed' };
  if (!fs.existsSync(paths.absolute)) return { ok: true, reason: null, worktree_path: paths.relative, removed: false };

  const remove = git(['worktree', 'remove', '--force', paths.absolute], { rootDir, spawn, env });
  if (remove.status === 0) {
    return { ok: true, reason: null, worktree_path: paths.relative, removed: true };
  }

  try { fs.rmSync(paths.absolute, { recursive: true, force: true }); } catch { /* swallow */ }
  git(['worktree', 'prune'], { rootDir, spawn, env, timeout: 10000 });
  return {
    ok: !fs.existsSync(paths.absolute),
    reason: fs.existsSync(paths.absolute) ? 'worktree_remove_failed' : null,
    worktree_path: paths.relative,
    removed: !fs.existsSync(paths.absolute),
    stderr_preview: String(remove.stderr || '').slice(0, 600)
  };
}

function diffStoryWorktree({ rootDir, sandbox_root, base_sha, spawn = spawnSync, env = process.env, timeout = DEFAULT_DIFF_TIMEOUT_MS } = {}) {
  const paths = worktreePathFor(rootDir, sandbox_root);
  if (!paths) return { ok: false, reason: 'worktree_sandbox_root_not_allowed', patch_text: '' };
  if (!fs.existsSync(paths.absolute)) return { ok: false, reason: 'worktree_not_present', patch_text: '' };

  const stage = git(['add', '--intent-to-add', '--all', '--'], { rootDir: paths.absolute, spawn, env, timeout: 30000 });
  if (stage.status !== 0) {
    return {
      ok: false,
      reason: 'worktree_intent_to_add_failed',
      patch_text: '',
      stderr_preview: String(stage.stderr || '').slice(0, 600)
    };
  }

  const baseArg = base_sha && /^[A-Fa-f0-9]{4,64}$/.test(String(base_sha).trim()) ? String(base_sha).trim() : 'HEAD';
  // Exclude Ralph's own delivery artifacts from the captured diff. Agents
  // sometimes write a literal `candidate.patch` or `candidate.diff` file when
  // they misinterpret legacy NemoClaw-era output contract instructions; without
  // these excludes the diff would include that file and trip the requested-paths
  // validator. Also exclude OpenCode's session metadata directory so an agent
  // run that happens to bump it does not leak into the patch.
  const diff = git([
    'diff',
    '--no-color',
    '--no-ext-diff',
    baseArg,
    '--',
    ':(exclude)candidate.patch',
    ':(exclude)candidate.diff',
    ':(exclude).opencode',
    ':(exclude).opencode/**'
  ], { rootDir: paths.absolute, spawn, env, timeout });
  if (diff.status !== 0 && diff.status !== 1) {
    return {
      ok: false,
      reason: 'worktree_diff_failed',
      patch_text: '',
      stderr_preview: String(diff.stderr || '').slice(0, 600)
    };
  }

  return {
    ok: true,
    reason: null,
    patch_text: String(diff.stdout || ''),
    base_sha: baseArg
  };
}

module.exports = {
  ALLOWED_SANDBOX_PREFIXES,
  WORKTREE_SUBDIR,
  isAllowedSandboxRoot,
  worktreePathFor,
  resolveHeadSha,
  createStoryWorktree,
  destroyStoryWorktree,
  diffStoryWorktree
};
