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

// ============================================================
// Phase 6 #1: github_pr_already_exists graceful handling
// ============================================================

const { lookupExistingPullRequest } = require('../../src/ralph/github-pr-client');

function fakeSpawnWithList(plan) {
  // Extended fakeSpawn that ALSO routes `pr list ...` to plan.pr_list.
  return function spawn(command, args, opts) {
    if (args[0] === '--version') return { status: 0, stdout: 'gh 2.0\n', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create') return plan.pr_create || { status: 1, stdout: '', stderr: 'unspecified' };
    if (args[0] === 'pr' && args[1] === 'list') return plan.pr_list || { status: 0, stdout: '[]', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('Phase 6 #1: lookupExistingPullRequest returns ok with reused_existing when gh pr list finds a match', () => {
  const spawn = fakeSpawnWithList({
    pr_list: { status: 0, stdout: '[{"number":42,"url":"https://github.com/owner/repo/pull/42"}]', stderr: '' }
  });
  const r = lookupExistingPullRequest({
    repository_full_name: 'owner/repo',
    head: 'auto/STORY-X',
    spawn
  });
  expect(r).toMatchObject({
    ok: true,
    url: 'https://github.com/owner/repo/pull/42',
    html_url: 'https://github.com/owner/repo/pull/42',
    number: 42,
    reused_existing: true
  });
});

test('Phase 6 #1: lookupExistingPullRequest returns github_pr_not_found when no matching PR', () => {
  const spawn = fakeSpawnWithList({ pr_list: { status: 0, stdout: '[]', stderr: '' } });
  const r = lookupExistingPullRequest({
    repository_full_name: 'owner/repo',
    head: 'auto/STORY-Y',
    spawn
  });
  expect(r).toMatchObject({ ok: false, reason: 'github_pr_not_found' });
});

test('Phase 6 #1: lookupExistingPullRequest validates repository_full_name and head before spawning', () => {
  let spawned = false;
  const spawn = (...args) => { spawned = true; return { status: 0, stdout: '', stderr: '' }; };
  const badRepo = lookupExistingPullRequest({ repository_full_name: 'evil; rm -rf /', head: 'feature/x', spawn });
  expect(badRepo).toMatchObject({ ok: false, reason: 'github_repository_invalid' });
  const badHead = lookupExistingPullRequest({ repository_full_name: 'owner/repo', head: 'evil; rm', spawn });
  expect(badHead).toMatchObject({ ok: false, reason: 'github_head_branch_invalid' });
  expect(spawned).toBe(false);
});

test('Phase 6 #1: lookupExistingPullRequest reports github_pr_lookup_failed on gh failure', () => {
  const spawn = fakeSpawnWithList({ pr_list: { status: 1, stdout: '', stderr: 'gh: network unreachable' } });
  const r = lookupExistingPullRequest({
    repository_full_name: 'owner/repo',
    head: 'auto/STORY-Z',
    spawn
  });
  expect(r).toMatchObject({ ok: false, reason: 'github_pr_lookup_failed' });
  expect(r.stderr_preview).toContain('network unreachable');
});

test('Phase 6 #1: lookupExistingPullRequest reports invalid_json on malformed gh output', () => {
  const spawn = fakeSpawnWithList({ pr_list: { status: 0, stdout: 'not json', stderr: '' } });
  const r = lookupExistingPullRequest({
    repository_full_name: 'owner/repo',
    head: 'auto/STORY-J',
    spawn
  });
  expect(r).toMatchObject({ ok: false, reason: 'github_pr_lookup_invalid_json' });
});

test('Phase 6 #1: createGhPullRequest with already-exists + successful lookup returns ok with the existing PR', () => {
  // The Phase 5 #4 auto-repair scenario: a second commit on the same branch
  // tries to create a PR, gh errors with "already exists", we look up the
  // existing PR and return success so the loop can advance to PR_REVIEW.
  const spawn = fakeSpawnWithList({
    pr_create: { status: 1, stdout: '', stderr: 'a pull request for branch auto/STORY-X already exists: https://...' },
    pr_list: { status: 0, stdout: '[{"number":101,"url":"https://github.com/owner/repo/pull/101"}]', stderr: '' }
  });
  const r = createGhPullRequest({
    repository_full_name: 'owner/repo',
    title: 'Phase 5 #4 second pass',
    body: 'b',
    head: 'auto/STORY-X',
    base: 'main',
    spawn
  });
  expect(r).toMatchObject({
    ok: true,
    number: 101,
    url: 'https://github.com/owner/repo/pull/101',
    reused_existing: true
  });
});

test('Phase 6 #1: createGhPullRequest with already-exists + failed lookup still surfaces the failure', () => {
  // If the lookup itself fails for any reason, we MUST NOT silently swallow
  // the error — surface the original github_pr_already_exists plus a
  // lookup_attempt field so the operator can diagnose.
  const spawn = fakeSpawnWithList({
    pr_create: { status: 1, stdout: '', stderr: 'already exists for this branch' },
    pr_list: { status: 1, stdout: '', stderr: 'gh: server error' }
  });
  const r = createGhPullRequest({
    repository_full_name: 'owner/repo',
    title: 't', body: 'b', head: 'auto/STORY-K', base: 'main',
    spawn
  });
  expect(r).toMatchObject({
    ok: false,
    reason: 'github_pr_already_exists'
  });
  expect(r.lookup_attempt).toMatchObject({ ok: false, reason: 'github_pr_lookup_failed' });
});

test('Phase 6 #1: createGhPullRequest with already-exists + no PR found in lookup still surfaces failure', () => {
  // Edge case: gh said the PR exists but the lookup returns []. This is
  // theoretically impossible but we handle it gracefully — fall through
  // to the original failure path with lookup_attempt for diagnostics.
  const spawn = fakeSpawnWithList({
    pr_create: { status: 1, stdout: '', stderr: 'already exists' },
    pr_list: { status: 0, stdout: '[]', stderr: '' }
  });
  const r = createGhPullRequest({
    repository_full_name: 'owner/repo',
    title: 't', body: 'b', head: 'auto/STORY-M', base: 'main',
    spawn
  });
  expect(r).toMatchObject({
    ok: false,
    reason: 'github_pr_already_exists'
  });
  expect(r.lookup_attempt).toMatchObject({ ok: false, reason: 'github_pr_not_found' });
});
