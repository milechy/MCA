const { spawnSync } = require('node:child_process');

const DEFAULT_GH_TIMEOUT_MS = 30000;
const SAFE_BRANCH = /^[A-Za-z0-9_./-]+$/;
const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function oneLine(value, maxLength = 600) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function ghAvailable({ spawn = spawnSync, env = process.env, timeout = 5000 } = {}) {
  try {
    const r = spawn('gh', ['--version'], { env: { PATH: env.PATH, HOME: env.HOME }, encoding: 'utf8', timeout });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Phase 6 #1: when `gh pr create` fails with "already exists" we must NOT
// surface that as a hard failure — the autonomous loop's Phase 5 #4
// auto-repair path pushes a second commit to the same branch, then asks
// the PR-creation step to run again. The branch already has an open PR
// from the first pass; we just need to look it up and return its
// number/url so the loop can advance to PR_REVIEW instead of escalating.
function lookupExistingPullRequest({
  repository_full_name,
  head,
  env = process.env,
  spawn = spawnSync,
  timeout = DEFAULT_GH_TIMEOUT_MS
} = {}) {
  if (!repository_full_name || !SAFE_REPO.test(String(repository_full_name))) {
    return { ok: false, reason: 'github_repository_invalid' };
  }
  if (!head || !SAFE_BRANCH.test(String(head))) {
    return { ok: false, reason: 'github_head_branch_invalid' };
  }
  const cleanEnv = {
    PATH: env.PATH || '',
    HOME: env.HOME || '',
    GH_TOKEN: env.GH_TOKEN || env.GITHUB_TOKEN || '',
    GITHUB_TOKEN: env.GITHUB_TOKEN || env.GH_TOKEN || '',
    GIT_TERMINAL_PROMPT: '0'
  };
  // `gh pr list --head <branch>` returns matching PRs as JSON. We pick the
  // first OPEN one (auto-repair only matters when the original PR is still
  // open; if it was merged/closed already, we want fresh creation).
  const args = [
    'pr', 'list',
    '--repo', repository_full_name,
    '--head', head,
    '--state', 'open',
    '--json', 'number,url',
    '--limit', '1'
  ];
  const result = spawn('gh', args, { env: cleanEnv, encoding: 'utf8', timeout, maxBuffer: 1024 * 16 });
  if (result.status !== 0) {
    return {
      ok: false,
      reason: 'github_pr_lookup_failed',
      stderr_preview: oneLine(result.stderr || '', 300)
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || '[]'));
  } catch (err) {
    return {
      ok: false,
      reason: 'github_pr_lookup_invalid_json',
      stderr_preview: oneLine(err && err.message, 300)
    };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, reason: 'github_pr_not_found' };
  }
  const first = parsed[0];
  if (!first || typeof first.url !== 'string' || !Number.isFinite(first.number)) {
    return { ok: false, reason: 'github_pr_lookup_invalid_shape' };
  }
  return {
    ok: true,
    url: first.url,
    html_url: first.url,
    number: Number(first.number),
    reused_existing: true
  };
}

function createGhPullRequest({ repository_full_name, title, body, head, base, env = process.env, spawn = spawnSync, timeout = DEFAULT_GH_TIMEOUT_MS } = {}) {
  if (!repository_full_name || !SAFE_REPO.test(String(repository_full_name))) {
    return { ok: false, reason: 'github_repository_invalid' };
  }
  if (!head || !SAFE_BRANCH.test(String(head))) {
    return { ok: false, reason: 'github_head_branch_invalid' };
  }
  if (!base || !SAFE_BRANCH.test(String(base))) {
    return { ok: false, reason: 'github_base_branch_invalid' };
  }
  if (!ghAvailable({ spawn, env })) {
    return { ok: false, reason: 'gh_cli_not_installed' };
  }
  const safeTitle = oneLine(title, 240) || 'Ralph autonomous change';
  const safeBody = String(body || '').slice(0, 60000);
  const args = [
    'pr',
    'create',
    '--repo', repository_full_name,
    '--base', base,
    '--head', head,
    '--title', safeTitle,
    '--body', safeBody
  ];
  const cleanEnv = {
    PATH: env.PATH || '',
    HOME: env.HOME || '',
    GH_TOKEN: env.GH_TOKEN || env.GITHUB_TOKEN || '',
    GITHUB_TOKEN: env.GITHUB_TOKEN || env.GH_TOKEN || '',
    GIT_TERMINAL_PROMPT: '0'
  };
  const result = spawn('gh', args, { env: cleanEnv, encoding: 'utf8', timeout, maxBuffer: 1024 * 64 });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0) {
    // Phase 6 #1: detect "already exists" and resolve to the existing PR
    // instead of surfacing the failure. The auto-repair loop relies on this
    // so a second commit on the same branch advances to PR_REVIEW instead
    // of escalating. The lookup itself is best-effort — if it fails, we
    // fall through to the original failure path.
    if (/already exists/i.test(stderr)) {
      const existing = lookupExistingPullRequest({ repository_full_name, head, env, spawn, timeout });
      if (existing && existing.ok === true) {
        return existing; // { ok: true, url, html_url, number, reused_existing: true }
      }
      return {
        ok: false,
        reason: 'github_pr_already_exists',
        stderr_preview: oneLine(stderr, 300),
        stdout_preview: oneLine(stdout, 300),
        lookup_attempt: existing || null
      };
    }
    const reason = /authentication|401|403/i.test(stderr) ? 'github_authentication_failed'
      : 'github_pr_creation_failed';
    return {
      ok: false,
      reason,
      stderr_preview: oneLine(stderr, 300),
      stdout_preview: oneLine(stdout, 300)
    };
  }
  // gh pr create prints the PR URL on success
  const url = stdout.split('\n').find((line) => /^https:\/\/github\.com\//.test(line.trim()))?.trim() || stdout;
  const numberMatch = url.match(/\/pull\/(\d+)$/);
  return {
    ok: true,
    url,
    html_url: url,
    number: numberMatch ? Number(numberMatch[1]) : null
  };
}

function buildDefaultGithubPrClient({ env = process.env, spawn = spawnSync, timeout = DEFAULT_GH_TIMEOUT_MS } = {}) {
  return {
    createPullRequest(input = {}) {
      return createGhPullRequest({ ...input, env, spawn, timeout });
    }
  };
}

module.exports = {
  DEFAULT_GH_TIMEOUT_MS,
  ghAvailable,
  lookupExistingPullRequest,
  createGhPullRequest,
  buildDefaultGithubPrClient
};
