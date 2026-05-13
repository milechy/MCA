const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_MODEL,
  PATCH_SOURCE,
  MEDIATOR,
  RUNTIME_MODE,
  resolveModel,
  safeEnv,
  buildPrompt,
  buildWorktreePrompt,
  classifyFailure,
  dispatchOpenCodeKimi
} = require('../../src/ralph/opencode-kimi-dispatcher');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-kimi-dispatcher-'));
}

function fakeSpawn(plan) {
  const calls = [];
  const versionPlan = plan.version || { status: 0, stdout: 'opencode 1.14.39\n', stderr: '' };
  const runPlan = plan.run || { status: 0, stdout: '', stderr: '' };
  return function spawn(command, args, opts) {
    calls.push({ command, args, opts });
    if (Array.isArray(args) && args[0] === '--version') return { ...versionPlan, calls };
    if (Array.isArray(args) && args[0] === 'run') return { ...runPlan, calls };
    return { status: 0, stdout: '', stderr: '', calls };
  };
}

function story() {
  return {
    story_id: 'STORY-KIMI',
    title: 'Kimi dispatcher smoke',
    requirement: 'Generate a tiny markdown note via OpenCode + Kimi K2.',
    requested_paths: ['docs/kimi-smoke.md'],
    risk: { score: 0, category: 'low', label: 'RISK_0_LOW' }
  };
}

const SAMPLE_DIFF = `diff --git a/docs/kimi-smoke.md b/docs/kimi-smoke.md
new file mode 100644
index 0000000..0000000
--- /dev/null
+++ b/docs/kimi-smoke.md
@@ -0,0 +1,2 @@
+# Kimi smoke
+Body line.
`;

test('safeEnv drops everything except PATH/HOME/CI/TMPDIR and routes Kimi API key through OPENROUTER_API_KEY', () => {
  const env = safeEnv({
    PATH: '/bin',
    HOME: '/home/u',
    TMPDIR: '/tmp',
    CI: '',
    OPENROUTER_API_KEY: 'or-redacted-key',
    KIMI_API_KEY: 'unused-when-openrouter-set',
    DATABASE_PASSWORD: 'leaked-secret',
    SUPABASE_SERVICE_ROLE: 'leaked-secret'
  });
  expect(env).toEqual({
    PATH: '/bin',
    HOME: '/home/u',
    TMPDIR: '/tmp',
    CI: '',
    OPENROUTER_API_KEY: 'or-redacted-key',
    OPENCODE_DISABLE_TELEMETRY: '1'
  });
});

test('safeEnv falls back to KIMI_API_KEY when OPENROUTER_API_KEY is absent', () => {
  const env = safeEnv({ PATH: '/bin', HOME: '/u', KIMI_API_KEY: 'kimi-key' });
  expect(env.OPENROUTER_API_KEY).toBe('kimi-key');
});

test('resolveModel sanitizes input and falls back to default Kimi K2 model', () => {
  expect(resolveModel({})).toBe(DEFAULT_MODEL);
  expect(resolveModel({ OPENCODE_MODEL: 'openrouter/moonshotai/kimi-k2' })).toBe('openrouter/moonshotai/kimi-k2');
  expect(resolveModel({ OPENCODE_MODEL: 'bad model with spaces' })).toBe(DEFAULT_MODEL);
  expect(resolveModel({ OPENCODE_MODEL: 'evil; rm -rf /' })).toBe(DEFAULT_MODEL);
});

test('buildPrompt includes Ralph identity, requested paths, and Kimi role', () => {
  const prompt = buildPrompt({ task: 'do the thing', requested_paths: ['docs/x.md'], rootDir: tmpRoot() });
  expect(prompt).toContain('Ralph execution provider');
  expect(prompt).toContain('Kimi K2');
  expect(prompt).toContain('docs/x.md');
  expect(prompt).toContain('do the thing');
  expect(prompt).toContain('Return ONLY a unified git diff');
});

test('buildWorktreePrompt forbids writing literal candidate.patch and explains the worktree contract', () => {
  const prompt = buildWorktreePrompt({
    task: 'create docs/x.md',
    requested_paths: ['docs/x.md'],
    rootDir: tmpRoot()
  });
  // Worktree contract: edit files in place, do NOT write candidate.patch as a file.
  expect(prompt).toContain('isolated git worktree');
  expect(prompt).toContain('Do NOT write a file literally named "candidate.patch"');
  expect(prompt).toContain('docs/x.md');
  expect(prompt).toContain('create docs/x.md');
  // Must not still tell the agent to create a candidate.patch file.
  expect(prompt).not.toContain('Preferred: create exactly one file named candidate.patch');
  // Should not double up the legacy diff-only "Return ONLY a unified git diff" instruction either,
  // because in worktree mode the diff is captured by Ralph, not produced on stdout.
  expect(prompt).not.toContain('Return ONLY a unified git diff');
});

test('classifyFailure produces the expected reasons', () => {
  expect(classifyFailure({ missingKey: true })).toBe('opencode_kimi_api_key_missing');
  expect(classifyFailure({ timedOut: true })).toBe('opencode_kimi_runtime_timeout');
  expect(classifyFailure({ output: 'HTTP 429 too many requests' })).toBe('provider_rate_limited');
  expect(classifyFailure({ patchLooksValid: false })).toBe('candidate_patch_missing');
  expect(classifyFailure({ patchLooksValid: true, patchValidation: { ok: false, reason: 'candidate_patch_path_forbidden' } })).toBe('candidate_patch_path_forbidden');
  expect(classifyFailure({ patchLooksValid: true, patchValidation: { ok: true }, exitCode: 1 })).toBe('opencode_kimi_runtime_failed');
  expect(classifyFailure({ patchLooksValid: true, patchValidation: { ok: true }, exitCode: 0 })).toBeNull();
});

test('classifyFailure prefers patch validation reason over transient pattern noise in output', () => {
  // Regression: if the bounded stdout/stderr happens to contain a 429-like substring
  // (e.g. an unrelated upstream service mentioned in a chat log preview) AND the
  // patch was actually produced but rejected by validation, we must report the
  // real validation reason, not a misleading provider_rate_limited.
  const reason = classifyFailure({
    output: '... some agent log mentioning "rate limit" elsewhere ...',
    patchLooksValid: true,
    patchValidation: { ok: false, reason: 'candidate_patch_unrequested_path', path: 'candidate.patch' },
    exitCode: 0
  });
  expect(reason).toBe('candidate_patch_unrequested_path');
});

test('classifyFailure still surfaces provider_rate_limited when no valid patch was produced', () => {
  const reason = classifyFailure({
    output: 'HTTP 429 too many requests',
    patchLooksValid: false,
    exitCode: 0
  });
  expect(reason).toBe('provider_rate_limited');
});

test('dispatchOpenCodeKimi refuses non-allowed sandbox roots', () => {
  const rootDir = tmpRoot();
  const result = dispatchOpenCodeKimi({
    rootDir,
    story: story(),
    sandbox_root: 'tmp/outside-sandbox-root',
    task: 'task',
    requested_paths: ['docs/kimi-smoke.md'],
    spawn: fakeSpawn({}),
    env: { PATH: '/bin', HOME: '/u', OPENROUTER_API_KEY: 'or-key' },
    use_worktree: false
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'opencode_kimi_sandbox_root_not_allowed',
    execution_connected: false
  });
});

test('dispatchOpenCodeKimi reports api key missing without invoking opencode', () => {
  const rootDir = tmpRoot();
  const spawn = fakeSpawn({});
  const result = dispatchOpenCodeKimi({
    rootDir,
    story: story(),
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-KIMI',
    task: 'task',
    requested_paths: ['docs/kimi-smoke.md'],
    spawn,
    env: { PATH: '/bin', HOME: '/u' },
    use_worktree: false
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'opencode_kimi_api_key_missing',
    runtime_installed: true,
    execution_connected: false,
    next_action: 'set_openrouter_api_key_or_kimi_api_key_env'
  });
});

test('dispatchOpenCodeKimi writes candidate.patch when opencode emits a valid unified diff', () => {
  const rootDir = tmpRoot();
  const spawn = fakeSpawn({ run: { status: 0, stdout: SAMPLE_DIFF, stderr: '' } });
  const result = dispatchOpenCodeKimi({
    rootDir,
    story: story(),
    approval_id: 'APR-KIMI',
    job_id: 'JOB-KIMI',
    sandbox_root: '.ralph/sandboxes/STORY-KIMI',
    task: 'create docs/kimi-smoke.md',
    requested_paths: ['docs/kimi-smoke.md'],
    spawn,
    env: { PATH: '/bin', HOME: '/u', OPENROUTER_API_KEY: 'or-key' },
    use_worktree: false
  });
  expect(result).toMatchObject({
    ok: true,
    reason: null,
    mediator: MEDIATOR,
    opencode_runtime_mode: RUNTIME_MODE,
    patch_source: PATCH_SOURCE,
    execution_connected: true,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    candidate_patch_path: '.ralph/sandboxes/STORY-KIMI/candidate.patch',
    next_action: 'preview_candidate_patch_before_apply'
  });
  const patchPath = path.join(rootDir, result.candidate_patch_path);
  expect(fs.existsSync(patchPath)).toBe(true);
  const patch = fs.readFileSync(patchPath, 'utf8');
  expect(patch).toContain('diff --git a/docs/kimi-smoke.md b/docs/kimi-smoke.md');
});

test('dispatchOpenCodeKimi classifies provider rate limit even when stdout is empty', () => {
  const rootDir = tmpRoot();
  const spawn = fakeSpawn({ run: { status: 1, stdout: '', stderr: 'HTTP 429 rate limit reached' } });
  const result = dispatchOpenCodeKimi({
    rootDir,
    story: story(),
    approval_id: 'APR-KIMI',
    sandbox_root: '.ralph/sandboxes/STORY-KIMI',
    task: 'create docs/kimi-smoke.md',
    requested_paths: ['docs/kimi-smoke.md'],
    spawn,
    env: { PATH: '/bin', HOME: '/u', OPENROUTER_API_KEY: 'or-key' },
    use_worktree: false
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'provider_rate_limited',
    execution_connected: true,
    next_action: 'retry_after_provider_rate_limit'
  });
});

test('dispatchOpenCodeKimi rejects patches that touch paths outside requested_paths', () => {
  const rootDir = tmpRoot();
  const forbiddenDiff = `diff --git a/src/forbidden.js b/src/forbidden.js
new file mode 100644
index 0000000..0000000
--- /dev/null
+++ b/src/forbidden.js
@@ -0,0 +1,1 @@
+evil
`;
  const spawn = fakeSpawn({ run: { status: 0, stdout: forbiddenDiff, stderr: '' } });
  const result = dispatchOpenCodeKimi({
    rootDir,
    story: story(),
    approval_id: 'APR-KIMI',
    sandbox_root: '.ralph/sandboxes/STORY-KIMI',
    task: 'create docs/kimi-smoke.md',
    requested_paths: ['docs/kimi-smoke.md'],
    spawn,
    env: { PATH: '/bin', HOME: '/u', OPENROUTER_API_KEY: 'or-key' },
    use_worktree: false
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'candidate_patch_unrequested_path',
    execution_connected: true
  });
  expect(fs.existsSync(path.join(rootDir, '.ralph/sandboxes/STORY-KIMI/candidate.patch'))).toBe(false);
});

test('dispatchOpenCodeKimi reports runtime not installed when opencode version probe ENOENTs', () => {
  const rootDir = tmpRoot();
  function spawn(command, args) {
    if (args[0] === '--version') return { error: { code: 'ENOENT', message: 'not found' }, status: null, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }
  const result = dispatchOpenCodeKimi({
    rootDir,
    story: story(),
    sandbox_root: '.ralph/sandboxes/STORY-KIMI',
    task: 'task',
    requested_paths: ['docs/kimi-smoke.md'],
    spawn,
    env: { PATH: '/bin', HOME: '/u', OPENROUTER_API_KEY: 'or-key' },
    use_worktree: false
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'opencode_runtime_not_installed',
    execution_connected: false
  });
});

test('dispatchOpenCodeKimi (worktree mode) captures real git diff when fake opencode modifies a file in the worktree', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-kimi-wt-e2e-'));
  const realSpawnSync = require('node:child_process').spawnSync;
  function git(args) {
    return realSpawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com'
      }
    });
  }
  expect(git(['init', '-q', '-b', 'main']).status).toBe(0);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
  expect(git(['add', '.']).status).toBe(0);
  expect(git(['commit', '-q', '-m', 'initial']).status).toBe(0);

  function spawn(command, args, opts) {
    if (command === 'git') return realSpawnSync(command, args, opts);
    if (command === 'opencode' && args[0] === '--version') return { status: 0, stdout: 'opencode 1.14.39\n', stderr: '' };
    if (command === 'opencode' && args[0] === 'run') {
      const dirIndex = args.indexOf('--dir');
      const cwd = dirIndex !== -1 ? args[dirIndex + 1] : opts && opts.cwd;
      fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'docs', 'kimi-e2e.md'), '# Kimi e2e\nbody\n');
      return { status: 0, stdout: '{"message":"ok"}', stderr: '' };
    }
    return realSpawnSync(command, args, opts);
  }

  const result = dispatchOpenCodeKimi({
    rootDir: repo,
    story: { story_id: 'STORY-KIMI-E2E', requested_paths: ['docs/kimi-e2e.md'] },
    approval_id: 'APR-KIMI',
    sandbox_root: '.ralph/sandboxes/STORY-KIMI-E2E',
    task: 'create docs/kimi-e2e.md',
    requested_paths: ['docs/kimi-e2e.md'],
    spawn,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENROUTER_API_KEY: 'or-key' }
  });

  expect(result).toMatchObject({
    ok: true,
    reason: null,
    worktree_used: true,
    patch_extraction_mode: 'worktree',
    patch_source: PATCH_SOURCE,
    candidate_patch_path: '.ralph/sandboxes/STORY-KIMI-E2E/candidate.patch'
  });

  const patch = fs.readFileSync(path.join(repo, result.candidate_patch_path), 'utf8');
  expect(patch).toContain('diff --git a/docs/kimi-e2e.md b/docs/kimi-e2e.md');
  expect(patch).toContain('+# Kimi e2e');

  expect(fs.existsSync(path.join(repo, 'docs', 'kimi-e2e.md'))).toBe(false);
  expect(fs.existsSync(path.join(repo, '.ralph/sandboxes/STORY-KIMI-E2E/worktree'))).toBe(false);
});

test('dispatchOpenCodeKimi (worktree mode) rejects patches that escape requested_paths even when opencode wrote them in the worktree', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-kimi-wt-forbidden-'));
  const realSpawnSync = require('node:child_process').spawnSync;
  function git(args) {
    return realSpawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com'
      }
    });
  }
  expect(git(['init', '-q', '-b', 'main']).status).toBe(0);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
  expect(git(['add', '.']).status).toBe(0);
  expect(git(['commit', '-q', '-m', 'initial']).status).toBe(0);

  function spawn(command, args, opts) {
    if (command === 'git') return realSpawnSync(command, args, opts);
    if (command === 'opencode' && args[0] === '--version') return { status: 0, stdout: 'opencode 1.14.39\n' };
    if (command === 'opencode' && args[0] === 'run') {
      const dirIndex = args.indexOf('--dir');
      const cwd = dirIndex !== -1 ? args[dirIndex + 1] : opts && opts.cwd;
      fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'src', 'forbidden.js'), 'console.log("evil")\n');
      return { status: 0, stdout: '', stderr: '' };
    }
    return realSpawnSync(command, args, opts);
  }

  const result = dispatchOpenCodeKimi({
    rootDir: repo,
    story: { story_id: 'STORY-KIMI-FORBID', requested_paths: ['docs/expected.md'] },
    approval_id: 'APR-KIMI',
    sandbox_root: '.ralph/sandboxes/STORY-KIMI-FORBID',
    task: 'expected to touch docs/expected.md only',
    requested_paths: ['docs/expected.md'],
    spawn,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENROUTER_API_KEY: 'or-key' }
  });

  expect(result).toMatchObject({
    ok: false,
    reason: 'candidate_patch_unrequested_path',
    worktree_used: true,
    patch_extraction_mode: 'worktree'
  });
  expect(fs.existsSync(path.join(repo, '.ralph/sandboxes/STORY-KIMI-FORBID/candidate.patch'))).toBe(false);
  expect(fs.existsSync(path.join(repo, 'src/forbidden.js'))).toBe(false);
});

test('dispatchOpenCodeKimi never injects unrelated secrets into spawned env', () => {
  const rootDir = tmpRoot();
  const observed = [];
  function spawn(command, args, opts) {
    observed.push({ command, args, env: opts && opts.env });
    if (args[0] === '--version') return { status: 0, stdout: 'opencode 1.14.39\n' };
    return { status: 0, stdout: SAMPLE_DIFF };
  }
  const result = dispatchOpenCodeKimi({
    rootDir,
    story: story(),
    sandbox_root: '.ralph/sandboxes/STORY-KIMI',
    task: 'task',
    requested_paths: ['docs/kimi-smoke.md'],
    spawn,
    env: {
      PATH: '/bin',
      HOME: '/u',
      OPENROUTER_API_KEY: 'or-key',
      SUPABASE_SERVICE_ROLE: 'must-not-leak',
      GITHUB_TOKEN: 'must-not-leak'
    }
  });
  expect(result.ok).toBe(true);
  const runCall = observed.find((entry) => entry.args[0] === 'run');
  expect(runCall.env).not.toHaveProperty('SUPABASE_SERVICE_ROLE');
  expect(runCall.env).not.toHaveProperty('GITHUB_TOKEN');
  expect(runCall.env.OPENROUTER_API_KEY).toBe('or-key');
});
