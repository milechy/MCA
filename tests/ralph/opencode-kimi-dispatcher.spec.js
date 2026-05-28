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
  readOpencodeAuthKey,
  buildPrompt,
  buildWorktreePrompt,
  buildRequestedPathsSection,
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

// Phase 8 #6: dispatcher should fall back to opencode auth.json when env is empty
function tmpHomeWithAuthJson(payload) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-'));
  const dir = path.join(home, '.local', 'share', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  if (payload != null) {
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(payload), 'utf8');
  }
  return home;
}

test('Phase 8 #6: readOpencodeAuthKey reads .openrouter.key from $HOME/.local/share/opencode/auth.json', () => {
  const home = tmpHomeWithAuthJson({ openrouter: { type: 'api', key: 'sk-or-fixture-12345' } });
  expect(readOpencodeAuthKey({ HOME: home })).toBe('sk-or-fixture-12345');
});

test('Phase 8 #6: readOpencodeAuthKey returns empty string when auth.json is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-no-auth-'));
  expect(readOpencodeAuthKey({ HOME: home })).toBe('');
});

test('Phase 8 #6: readOpencodeAuthKey returns empty string when auth.json has no openrouter entry', () => {
  const home = tmpHomeWithAuthJson({ someOtherProvider: { key: 'irrelevant' } });
  expect(readOpencodeAuthKey({ HOME: home })).toBe('');
});

test('Phase 8 #6: readOpencodeAuthKey returns empty string on malformed JSON (no throw)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bad-auth-'));
  const dir = path.join(home, '.local', 'share', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), '{ malformed not json', 'utf8');
  expect(readOpencodeAuthKey({ HOME: home })).toBe('');
});

test('Phase 8 #6: safeEnv falls back to opencode auth.json when both env vars are absent', () => {
  const home = tmpHomeWithAuthJson({ openrouter: { type: 'api', key: 'sk-or-from-auth-json' } });
  const env = safeEnv({ PATH: '/bin', HOME: home });
  expect(env.OPENROUTER_API_KEY).toBe('sk-or-from-auth-json');
});

test('Phase 8 #6: env OPENROUTER_API_KEY beats auth.json (env precedence preserved)', () => {
  const home = tmpHomeWithAuthJson({ openrouter: { type: 'api', key: 'sk-or-from-auth-json' } });
  const env = safeEnv({ PATH: '/bin', HOME: home, OPENROUTER_API_KEY: 'sk-or-from-env' });
  expect(env.OPENROUTER_API_KEY).toBe('sk-or-from-env');
});

test('Phase 8 #6: env KIMI_API_KEY beats auth.json when OPENROUTER_API_KEY missing', () => {
  const home = tmpHomeWithAuthJson({ openrouter: { type: 'api', key: 'sk-or-from-auth-json' } });
  const env = safeEnv({ PATH: '/bin', HOME: home, KIMI_API_KEY: 'sk-kimi-from-env' });
  expect(env.OPENROUTER_API_KEY).toBe('sk-kimi-from-env');
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

test('dispatchOpenCodeKimi (worktree mode) accepts soft-timeout when a valid candidate patch was produced anyway', () => {
  const rootDir = tmpRoot();
  // Initialize a real git repo so the worktree create / diff path works.
  const { spawnSync } = require('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: rootDir });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: rootDir });

  // Fake spawn: opencode finishes writing the requested file inside the worktree
  // (we mutate filesystem from inside the fake), then returns an ETIMEDOUT error
  // as if the session never cleanly exited.
  function spawn(command, args, opts) {
    if (Array.isArray(args) && args[0] === '--version') {
      return { status: 0, stdout: 'opencode 1.14.39\n', stderr: '' };
    }
    if (Array.isArray(args) && args[0] === 'run') {
      // Find the --dir target so we can write directly into the worktree.
      const dirIdx = args.indexOf('--dir');
      const workDir = dirIdx >= 0 ? args[dirIdx + 1] : opts.cwd;
      const targetDir = path.join(workDir, 'docs');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'soft-timeout-note.md'), '# soft timeout\n');
      return {
        error: { code: 'ETIMEDOUT', message: 'session did not exit' },
        status: null,
        stdout: 'partial agent log...',
        stderr: ''
      };
    }
    // pass through to real spawn for git operations (worktree create/diff/remove)
    return spawnSync(command, args, opts);
  }

  const result = dispatchOpenCodeKimi({
    rootDir,
    story: { story_id: 'STORY-SOFT', title: 'soft', requirement: 'soft', requested_paths: ['docs/soft-timeout-note.md'] },
    approval_id: 'APR-SOFT',
    job_id: 'JOB-SOFT',
    sandbox_root: '.ralph/sandboxes/STORY-SOFT',
    task: 'create docs/soft-timeout-note.md',
    requested_paths: ['docs/soft-timeout-note.md'],
    timeout_ms: 5000,
    use_worktree: true,
    spawn,
    env: { PATH: process.env.PATH, HOME: '/tmp', OPENROUTER_API_KEY: 'or-key' }
  });
  expect(result).toMatchObject({
    ok: true,
    reason: null,
    candidate_patch_path: '.ralph/sandboxes/STORY-SOFT/candidate.patch',
    next_action: 'preview_candidate_patch_before_apply'
  });
  expect(fs.existsSync(path.join(rootDir, result.candidate_patch_path))).toBe(true);
});

test('dispatchOpenCodeKimi keeps timeout failure when no valid patch was produced', () => {
  const rootDir = tmpRoot();
  const { spawnSync } = require('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: rootDir });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: rootDir });

  function spawn(command, args, opts) {
    if (Array.isArray(args) && args[0] === '--version') return { status: 0, stdout: 'opencode 1.14.39\n' };
    if (Array.isArray(args) && args[0] === 'run') {
      // No files written. Just timeout.
      return { error: { code: 'ETIMEDOUT', message: 'no work done' }, status: null, stdout: '', stderr: '' };
    }
    return spawnSync(command, args, opts);
  }

  const result = dispatchOpenCodeKimi({
    rootDir,
    story: { story_id: 'STORY-HARD-TO', title: 'hard timeout', requirement: 'hard', requested_paths: ['docs/x.md'] },
    approval_id: 'APR-HARD-TO',
    sandbox_root: '.ralph/sandboxes/STORY-HARD-TO',
    task: 'create docs/x.md',
    requested_paths: ['docs/x.md'],
    timeout_ms: 5000,
    use_worktree: true,
    spawn,
    env: { PATH: process.env.PATH, HOME: '/tmp', OPENROUTER_API_KEY: 'or-key' }
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'opencode_kimi_runtime_timeout',
    next_action: 'retry_or_increase_opencode_kimi_timeout'
  });
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
  // Restored after Phase 2 #4 autonomous dogfood (PR #141) inadvertently
  // deleted this test while modifying the file. The story spec said
  // "Add new tests after the existing tests"; Kimi K2.6 misinterpreted
  // and replaced the last existing test with the new ones. The deleted
  // test is the Phase 1 env-scrubbing security guard — we must keep it.
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

test('Phase 2 #4: buildRequestedPathsSection classifies existing vs new files', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-kimi-dispatcher-phase2-'));
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'src', 'existing.js'), '// existing\n');

  const section = buildRequestedPathsSection({
    rootDir,
    requested_paths: ['src/existing.js', 'src/new.js']
  });

  expect(section).toContain('Requested paths (you MUST touch ALL of them):');
  expect(section).toContain('1. src/existing.js (MODIFY EXISTING)');
  expect(section).toContain('2. src/new.js (CREATE)');
});

test('Phase 2 #4: buildWorktreePrompt no longer says partial output is acceptable', () => {
  const rootDir = tmpRoot();
  fs.mkdirSync(path.join(rootDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'docs', 'x.md'), '# x\n');

  const prompt = buildWorktreePrompt({
    task: 'create docs/x.md and docs/y.md',
    requested_paths: ['docs/x.md', 'docs/y.md'],
    rootDir
  });

  expect(prompt).not.toContain('acceptable to create only a subset');
  expect(prompt).toContain('You MUST produce changes for EVERY path');
  expect(prompt).toContain('docs/x.md (MODIFY EXISTING)');
  expect(prompt).toContain('docs/y.md (CREATE)');
});

test('Phase 2 #4: buildWorktreePrompt with empty requested_paths still produces valid prompt', () => {
  const rootDir = tmpRoot();
  const prompt = buildWorktreePrompt({
    task: 'do nothing',
    requested_paths: [],
    rootDir
  });

  expect(prompt).toContain('Requested paths (you MUST touch ALL of them):');
  // Should not crash and should still contain task
  expect(prompt).toContain('do nothing');
});

test('Phase 2 #4.1: buildWorktreePrompt forbids deleting existing tests / functions when modifying', () => {
  const rootDir = tmpRoot();
  const prompt = buildWorktreePrompt({ task: 'modify the file', requested_paths: ['tests/example.spec.js'], rootDir });
  // Phase 3 #5.1 strengthened wording: now phrased as "APPEND-ONLY for existing files"
  // and "MUST preserve every pre-existing test, function, export, comment". The behavioral
  // contract (forbid deletion of pre-existing tests/functions) is unchanged.
  expect(prompt).toContain('APPEND-ONLY for existing files');
  expect(prompt).toContain('MUST preserve every pre-existing test');
  expect(prompt).toContain('Only APPEND new content');
  expect(prompt).toContain('roll back any patch that removes pre-existing tests');
});

test('Phase 2 #5: dispatchOpenCodeKimi refuses dispatch when daily budget is exceeded', () => {
  const rootDir = tmpRoot();
  fs.mkdirSync(path.join(rootDir, '.ralph'), { recursive: true });
  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  const entry = {
    at: new Date().toISOString(),
    story_id: 'STORY-EXPENSIVE',
    model: 'openrouter/moonshotai/kimi-k2.6',
    input_tokens: 100_000_000,
    output_tokens: 100_000_000,
    cost_usd: 100.0
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');

  let runCalled = false;
  function spawn(command, args) {
    if (Array.isArray(args) && args[0] === 'run') runCalled = true;
    return { status: 0, stdout: '', stderr: '' };
  }

  const result = dispatchOpenCodeKimi({
    rootDir,
    story: story(),
    sandbox_root: '.ralph/sandboxes/STORY-KIMI',
    task: 'task',
    requested_paths: ['docs/kimi-smoke.md'],
    spawn,
    env: { PATH: '/bin', HOME: '/u', OPENROUTER_API_KEY: 'or-key', RALPH_KIMI_DAILY_BUDGET_USD: '0.01' },
    use_worktree: false
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'kimi_daily_budget_exceeded',
    runtime_installed: true,
    next_action: 'retry_after_kimi_budget_reset'
  });
  expect(runCalled).toBe(false);
});

test('Phase 2 #5: dispatchOpenCodeKimi records cost telemetry after a successful run', () => {
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
  expect(result.ok).toBe(true);

  const ledgerPath = path.join(rootDir, '.ralph', 'cost-ledger.jsonl');
  expect(fs.existsSync(ledgerPath)).toBe(true);
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  expect(lines.length).toBe(1);
  const entry = JSON.parse(lines[0]);
  expect(entry.story_id).toBe('STORY-KIMI');
  expect(entry.model).toBe(DEFAULT_MODEL);
  expect(entry.input_tokens).toBeGreaterThanOrEqual(0);
  expect(entry.output_tokens).toBeGreaterThanOrEqual(0);
  expect(entry.cost_usd).toBeGreaterThanOrEqual(0);
});

test('Phase 2 #5: dispatchOpenCodeKimi allows dispatch when under daily budget', () => {
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
    env: { PATH: '/bin', HOME: '/u', OPENROUTER_API_KEY: 'or-key', RALPH_KIMI_DAILY_BUDGET_USD: '500' },
    use_worktree: false
  });
  expect(result).toMatchObject({
    ok: true,
    reason: null,
    patch_source: PATCH_SOURCE,
    next_action: 'preview_candidate_patch_before_apply'
  });
});


test('Phase 3 #1: resolveModel honors story.executor_model over env defaults', () => {
  const { resolveModel } = require('../../src/ralph/opencode-kimi-dispatcher');

  // No story → env-based default (or DEFAULT_MODEL)
  expect(resolveModel({ OPENCODE_MODEL: 'openrouter/openai/gpt-5' }, null))
    .toBe('openrouter/openai/gpt-5');

  // Story overrides env
  expect(resolveModel(
    { OPENCODE_MODEL: 'openrouter/openai/gpt-5' },
    { executor_model: 'openrouter/anthropic/claude-sonnet-4.6' }
  )).toBe('openrouter/anthropic/claude-sonnet-4.6');

  // Story with empty executor_model → fall back to env
  expect(resolveModel(
    { OPENCODE_MODEL: 'openrouter/openai/gpt-5' },
    { executor_model: '' }
  )).toBe('openrouter/openai/gpt-5');

  // Story with shell-meta characters in executor_model → rejected, falls back to env
  expect(resolveModel(
    { OPENCODE_MODEL: 'openrouter/openai/gpt-5' },
    { executor_model: 'evil; rm -rf /' }
  )).toBe('openrouter/openai/gpt-5');

  // No story and no env → DEFAULT_MODEL
  const { DEFAULT_MODEL } = require('../../src/ralph/opencode-kimi-dispatcher');
  expect(resolveModel({}, null)).toBe(DEFAULT_MODEL);
});

test('Phase 3 #5: dispatchOpenCodeKimi uses executor-router fallback when story.executor_model is unknown', () => {
  // Story with an unknown executor_model should still dispatch — via the FALLBACK_EXECUTOR_MODEL (kimi-k2.6).
  const rootDir = tmpRoot();
  const { spawnSync } = require('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: rootDir });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: rootDir });

  let seenModel;
  function spawn(command, args, opts) {
    if (Array.isArray(args) && args[0] === '--version') return { status: 0, stdout: 'opencode 1.14.39\n' };
    if (Array.isArray(args) && args[0] === 'run') {
      // args[2] is the model after '--model'
      seenModel = args[2];
      const dirIdx = args.indexOf('--dir');
      const workDir = dirIdx >= 0 ? args[dirIdx + 1] : opts.cwd;
      fs.mkdirSync(path.join(workDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(workDir, 'docs', 'hello.md'), '# hi\n');
      return { status: 0, stdout: 'ok' };
    }
    // pass through to real spawn for git (worktree) operations
    return spawnSync(command, args, opts);
  }

  const storyWithBadModel = { ...story(), executor_model: 'some/unknown/model-not-in-allowlist' };
  const result = dispatchOpenCodeKimi({
    rootDir,
    story: storyWithBadModel,
    sandbox_root: '.ralph/sandboxes/STORY-PHASE3-5',
    task: 'create docs/hello.md',
    requested_paths: ['docs/hello.md'],
    spawn,
    env: { PATH: process.env.PATH, HOME: '/tmp', OPENROUTER_API_KEY: 'or-key' }
  });

  expect(result.ok).toBe(true);
  expect(seenModel).toBe('openrouter/moonshotai/kimi-k2.6');
});

test('Phase 3 #5: dispatchOpenCodeKimi honors story.executor_model when it IS in the allowlist', () => {
  const rootDir = tmpRoot();
  const { spawnSync } = require('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rootDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: rootDir });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: rootDir });

  let seenModel;
  function spawn(command, args, opts) {
    if (Array.isArray(args) && args[0] === '--version') return { status: 0, stdout: 'opencode 1.14.39\n' };
    if (Array.isArray(args) && args[0] === 'run') {
      seenModel = args[2];
      const dirIdx = args.indexOf('--dir');
      const workDir = dirIdx >= 0 ? args[dirIdx + 1] : opts.cwd;
      fs.mkdirSync(path.join(workDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(workDir, 'docs', 'hello.md'), '# hi\n');
      return { status: 0, stdout: 'ok' };
    }
    return spawnSync(command, args, opts);
  }

  const storyWithClaude = { ...story(), executor_model: 'openrouter/anthropic/claude-sonnet-4.6' };
  const result = dispatchOpenCodeKimi({
    rootDir,
    story: storyWithClaude,
    sandbox_root: '.ralph/sandboxes/STORY-PHASE3-5-CLAUDE',
    task: 'create docs/hello.md',
    requested_paths: ['docs/hello.md'],
    spawn,
    env: { PATH: process.env.PATH, HOME: '/tmp', OPENROUTER_API_KEY: 'or-key' }
  });

  expect(result.ok).toBe(true);
  expect(seenModel).toBe('openrouter/anthropic/claude-sonnet-4.6');
});

test('Phase 3 #5.1: buildRequestedPathsSection inlines preserve-existing hint next to MODIFY EXISTING entries', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-kimi-dispatcher-phase351-'));
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'src', 'existing.js'), '// existing\n');

  const section = buildRequestedPathsSection({
    rootDir,
    requested_paths: ['src/existing.js', 'src/new.js']
  });

  // MODIFY EXISTING entry should carry an inline reminder so it cannot be missed.
  expect(section).toMatch(/1\. src\/existing\.js \(MODIFY EXISTING\).*APPEND-only/);
  expect(section).toContain('every existing test, function, export, comment, and require statement in this file MUST still exist verbatim');
  // CREATE entries should NOT carry the preserve hint (it would be confusing).
  expect(section).toContain('2. src/new.js (CREATE)');
  expect(section).not.toMatch(/2\. src\/new\.js \(CREATE\) — APPEND-only/);
  // Self-check footer appears when at least one MODIFY EXISTING is present.
  expect(section).toContain('Self-check before you stop');
});

test('Phase 3 #5.1: buildRequestedPathsSection omits Self-check footer when only CREATE entries', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-kimi-dispatcher-phase351-create-'));
  const section = buildRequestedPathsSection({
    rootDir,
    requested_paths: ['src/new-a.js', 'src/new-b.js']
  });
  expect(section).toContain('1. src/new-a.js (CREATE)');
  expect(section).toContain('2. src/new-b.js (CREATE)');
  expect(section).not.toContain('Self-check before you stop');
});

test('Phase 3 #5.1: buildWorktreePrompt promotes APPEND-ONLY rule to the first hard constraint', () => {
  const rootDir = tmpRoot();
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'src', 'a.js'), '// a\n');

  const prompt = buildWorktreePrompt({
    task: 'modify src/a.js',
    requested_paths: ['src/a.js'],
    rootDir
  });

  const hardConstraintsIdx = prompt.indexOf('Hard constraints:');
  const appendOnlyIdx = prompt.indexOf('APPEND-ONLY for existing files');
  const noTouchOutsideIdx = prompt.indexOf('Do NOT touch any path outside');

  expect(hardConstraintsIdx).toBeGreaterThan(-1);
  expect(appendOnlyIdx).toBeGreaterThan(hardConstraintsIdx);
  // APPEND-ONLY must come BEFORE the other hard constraints so Kimi reads it first.
  expect(appendOnlyIdx).toBeLessThan(noTouchOutsideIdx);
});
