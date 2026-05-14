const { test, expect } = require('@playwright/test');

const {
  createGhPullRequest,
  buildDefaultGithubPrClient
} = require('../../src/ralph/github-pr-client');

function fakeSpawn(plan) {
  const calls = [];
  return function spawn(command, args, opts) {
    calls.push({ command, args, env: opts && opts.env });
    if (args[0] === '--version') return { status: 0, stdout: 'gh 2.0\n', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create') return plan.pr_create || { status: 1, stdout: '', stderr: 'unspecified' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('createGhPullRequest rejects malformed repository names', () => {
  const r = createGhPullRequest({
    repository_full_name: 'evil; rm -rf /',
    title: 't', body: 'b', head: 'feature/x', base: 'main',
    spawn: fakeSpawn({})
  });
  expect(r).toMatchObject({ ok: false, reason: 'github_repository_invalid' });
});

test('createGhPullRequest rejects unsafe head / base branch names', () => {
  const r1 = createGhPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b',
    head: 'feature/--upload-pack=evil', base: 'main',
    spawn: fakeSpawn({})
  });
  expect(r1).toMatchObject({ ok: false, reason: 'github_head_branch_invalid' });

  const r2 = createGhPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b',
    head: 'feature/x', base: 'main; rm -rf /',
    spawn: fakeSpawn({})
  });
  expect(r2).toMatchObject({ ok: false, reason: 'github_base_branch_invalid' });
});

test('createGhPullRequest reports gh_cli_not_installed when --version ENOENT-s', () => {
  function spawn(command, args) {
    if (args[0] === '--version') return { error: { code: 'ENOENT' }, status: null, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }
  const r = createGhPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b',
    head: 'feature/x', base: 'main',
    spawn
  });
  expect(r).toMatchObject({ ok: false, reason: 'gh_cli_not_installed' });
});

test('createGhPullRequest returns ok with parsed URL and number on success', () => {
  const fake = fakeSpawn({ pr_create: { status: 0, stdout: 'https://github.com/owner/repo/pull/42\n', stderr: '' } });
  const r = createGhPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b',
    head: 'feature/x', base: 'main',
    spawn: fake
  });
  expect(r).toMatchObject({ ok: true, number: 42, url: 'https://github.com/owner/repo/pull/42' });
});

test('createGhPullRequest classifies already-exists, auth, and generic failures', () => {
  const exists = createGhPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b', head: 'feature/x', base: 'main',
    spawn: fakeSpawn({ pr_create: { status: 1, stdout: '', stderr: 'a pull request for this branch already exists' } })
  });
  expect(exists).toMatchObject({ ok: false, reason: 'github_pr_already_exists' });

  const auth = createGhPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b', head: 'feature/x', base: 'main',
    spawn: fakeSpawn({ pr_create: { status: 1, stdout: '', stderr: 'HTTP 401 authentication required' } })
  });
  expect(auth).toMatchObject({ ok: false, reason: 'github_authentication_failed' });

  const generic = createGhPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b', head: 'feature/x', base: 'main',
    spawn: fakeSpawn({ pr_create: { status: 1, stdout: '', stderr: 'network unreachable' } })
  });
  expect(generic).toMatchObject({ ok: false, reason: 'github_pr_creation_failed' });
});

test('createGhPullRequest scrubs env down to PATH/HOME/GH_TOKEN/GITHUB_TOKEN/GIT_TERMINAL_PROMPT', () => {
  const fake = fakeSpawn({ pr_create: { status: 0, stdout: 'https://github.com/owner/repo/pull/1\n', stderr: '' } });
  createGhPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b', head: 'feature/x', base: 'main',
    spawn: fake,
    env: {
      PATH: '/bin',
      HOME: '/home/u',
      GITHUB_TOKEN: 'ghp-redacted',
      DATABASE_PASSWORD: 'must-not-leak',
      SUPABASE_SERVICE_ROLE: 'must-not-leak'
    }
  });
  // Find the pr create call (skipping the --version probe)
  // fakeSpawn captures into its closure; we cannot read it from here, but we
  // can re-verify by passing a spawn that records.
  const calls = [];
  const recording = (command, args, opts) => {
    calls.push({ command, args, env: opts && opts.env });
    if (args[0] === '--version') return { status: 0, stdout: 'gh 2.0\n' };
    return { status: 0, stdout: 'https://github.com/owner/repo/pull/1\n' };
  };
  createGhPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b', head: 'feature/x', base: 'main',
    spawn: recording,
    env: {
      PATH: '/bin',
      HOME: '/home/u',
      GITHUB_TOKEN: 'ghp-redacted',
      DATABASE_PASSWORD: 'must-not-leak',
      SUPABASE_SERVICE_ROLE: 'must-not-leak'
    }
  });
  const prCall = calls.find((c) => c.args[0] === 'pr');
  expect(prCall.env).not.toHaveProperty('DATABASE_PASSWORD');
  expect(prCall.env).not.toHaveProperty('SUPABASE_SERVICE_ROLE');
  expect(prCall.env.GH_TOKEN).toBe('ghp-redacted');
});

test('buildDefaultGithubPrClient exposes a createPullRequest method bound to the default spawn', () => {
  const client = buildDefaultGithubPrClient({ spawn: fakeSpawn({ pr_create: { status: 0, stdout: 'https://github.com/owner/repo/pull/9\n' } }) });
  const r = client.createPullRequest({
    repository_full_name: 'owner/repo', title: 't', body: 'b', head: 'feature/x', base: 'main'
  });
  expect(r).toMatchObject({ ok: true, number: 9 });
});
