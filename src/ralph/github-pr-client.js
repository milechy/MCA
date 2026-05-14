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
    const reason = /already exists/i.test(stderr) ? 'github_pr_already_exists'
      : /authentication|401|403/i.test(stderr) ? 'github_authentication_failed'
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
  createGhPullRequest,
  buildDefaultGithubPrClient
};
