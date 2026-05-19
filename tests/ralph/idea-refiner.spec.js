const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PLANNER_PROMPT_TEMPLATE,
  DEFAULT_PLANNER_MODEL,
  DEFAULT_MAX_RETRIES,
  refineIdea,
  buildRepoContext
} = require('../../src/ralph/idea-refiner');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idea-refiner-'));
}

function makeValidStdout(overrides = {}) {
  const spec = {
    title: 'Test Story',
    requirement: 'FILE 1 (CREATE): create a test file\nFILE 2 (MODIFY EXISTING): update existing file',
    requested_paths: ['src/test.js', 'tests/test.spec.js'],
    difficulty: 'easy',
    recommended_executor: 'openrouter/moonshotai/kimi-k2.6',
    reasoning: 'This is a test.',
    ...overrides
  };
  return JSON.stringify(spec);
}

function makeSpawnSync(stdout, status = 0, stderr = '') {
  return () => ({
    stdout,
    stderr,
    status,
    error: status !== 0 ? new Error('spawn error') : null
  });
}

test('PLANNER_PROMPT_TEMPLATE is a non-empty string containing placeholders', () => {
  expect(typeof PLANNER_PROMPT_TEMPLATE).toBe('string');
  expect(PLANNER_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
  expect(PLANNER_PROMPT_TEMPLATE).toContain('{IDEA}');
  expect(PLANNER_PROMPT_TEMPLATE).toContain('{REPO_CONTEXT}');
});

test('DEFAULT_PLANNER_MODEL has expected value', () => {
  expect(DEFAULT_PLANNER_MODEL).toBe('openrouter/anthropic/claude-sonnet-4.6');
});

test('DEFAULT_MAX_RETRIES has expected value', () => {
  expect(DEFAULT_MAX_RETRIES).toBe(1);
});

test('refineIdea returns idea_invalid for empty string', () => {
  const result = refineIdea({ idea: '', rootDir: tmpRoot(), spawn: makeSpawnSync('') });
  expect(result).toMatchObject({ ok: false, reason: 'idea_invalid' });
});

test('refineIdea returns idea_invalid for whitespace-only string', () => {
  const result = refineIdea({ idea: '   ', rootDir: tmpRoot(), spawn: makeSpawnSync('') });
  expect(result).toMatchObject({ ok: false, reason: 'idea_invalid' });
});

test('refineIdea returns idea_invalid for non-string', () => {
  const result = refineIdea({ idea: null, rootDir: tmpRoot(), spawn: makeSpawnSync('') });
  expect(result).toMatchObject({ ok: false, reason: 'idea_invalid' });
});

test('refineIdea returns idea_invalid for idea longer than 2000 chars', () => {
  const result = refineIdea({ idea: 'a'.repeat(2001), rootDir: tmpRoot(), spawn: makeSpawnSync('') });
  expect(result).toMatchObject({ ok: false, reason: 'idea_invalid' });
});

test('refineIdea accepts idea exactly 2000 chars', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const result = refineIdea({ idea: 'a'.repeat(2000), rootDir: tmpRoot(), spawn });
  expect(result.ok).toBe(true);
});

test('refineIdea returns planner_dispatch_failed when spawn exits non-zero', () => {
  const result = refineIdea({
    idea: 'add a feature',
    rootDir: tmpRoot(),
    spawn: makeSpawnSync('', 1, 'some error')
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'planner_dispatch_failed',
    stderr_preview: 'some error',
    exit_code: 1
  });
});

test('refineIdea returns planner_dispatch_failed on spawn error object', () => {
  const spawn = () => ({ stdout: '', stderr: '', status: null, error: new Error('ENOENT') });
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), spawn });
  expect(result).toMatchObject({
    ok: false,
    reason: 'planner_dispatch_failed',
    exit_code: -1
  });
});

test('refineIdea retries once on invalid JSON then succeeds', () => {
  let callCount = 0;
  const spawn = () => {
    callCount++;
    if (callCount === 1) {
      return { stdout: 'not json', stderr: '', status: 0, error: null };
    }
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), spawn });
  expect(result.ok).toBe(true);
  expect(result.retry_count).toBe(1);
  expect(callCount).toBe(2);
});

test('refineIdea retries once on invalid shape then succeeds', () => {
  let callCount = 0;
  const spawn = () => {
    callCount++;
    if (callCount === 1) {
      return { stdout: JSON.stringify({ title: 'x', requirement: 'no file header', requested_paths: [], difficulty: 'easy', recommended_executor: 'x', reasoning: 'x' }), stderr: '', status: 0, error: null };
    }
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), spawn });
  expect(result.ok).toBe(true);
  expect(result.retry_count).toBe(1);
});

test('refineIdea returns planner_invalid_response after exhausting retries', () => {
  const spawn = () => ({ stdout: 'bad json', stderr: '', status: 0, error: null });
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), spawn });
  expect(result).toMatchObject({
    ok: false,
    reason: 'planner_invalid_response',
    retry_count: 1
  });
  expect(result.last_raw_preview).toBe('bad json');
});

test('refineIdea returns success with correct story_spec shape', () => {
  const spawn = makeSpawnSync(makeValidStdout());
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), spawn });
  expect(result.ok).toBe(true);
  expect(result.story_spec).toMatchObject({
    title: 'Test Story',
    requirement: expect.stringContaining('FILE 1'),
    requested_paths: ['src/test.js', 'tests/test.spec.js'],
    difficulty: 'easy',
    recommended_executor: 'openrouter/moonshotai/kimi-k2.6',
    reasoning: 'This is a test.'
  });
  expect(result.planner_model).toBe(DEFAULT_PLANNER_MODEL);
  expect(result.retry_count).toBe(0);
  expect(typeof result.raw_preview).toBe('string');
  expect(result.planner_cost_usd).toBeGreaterThanOrEqual(0);
});

test('refineIdea validates difficulty enum strictly', () => {
  const spawn = makeSpawnSync(makeValidStdout({ difficulty: 'impossible' }));
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), spawn });
  expect(result).toMatchObject({ ok: false, reason: 'planner_invalid_response' });
});

test('refineIdea validates requirement must contain FILE 1', () => {
  const spawn = makeSpawnSync(makeValidStdout({ requirement: 'do something without file header' }));
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), spawn });
  expect(result).toMatchObject({ ok: false, reason: 'planner_invalid_response' });
});

test('refineIdea validates requested_paths must be non-empty array', () => {
  const spawn = makeSpawnSync(makeValidStdout({ requested_paths: [] }));
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), spawn });
  expect(result).toMatchObject({ ok: false, reason: 'planner_invalid_response' });
});

test('refineIdea uses custom plannerModel and maxRetries=0', () => {
  let seenModel;
  const spawn = (cmd, args, opts) => {
    seenModel = args[2];
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const result = refineIdea({
    idea: 'add a feature',
    rootDir: tmpRoot(),
    plannerModel: 'openrouter/moonshotai/kimi-k2.6',
    maxRetries: 0,
    spawn
  });
  expect(result.ok).toBe(true);
  expect(seenModel).toBe('openrouter/moonshotai/kimi-k2.6');
});

test('refineIdea with maxRetries=0 does not retry on invalid JSON', () => {
  let callCount = 0;
  const spawn = () => {
    callCount++;
    return { stdout: 'bad', stderr: '', status: 0, error: null };
  };
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), maxRetries: 0, spawn });
  expect(result).toMatchObject({ ok: false, reason: 'planner_invalid_response', retry_count: 0 });
  expect(callCount).toBe(1);
});

test('refineIdea passes env and timeout to spawn', () => {
  let seenOpts;
  const env = { ...process.env, TEST_VAR: '1' };
  const spawn = (cmd, args, opts) => {
    seenOpts = opts;
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), env, spawn });
  expect(seenOpts.env).toBe(env);
  expect(seenOpts.timeout).toBe(120000);
  expect(seenOpts.encoding).toBe('utf8');
});

test('refineIdea returns planner_dispatch_failed on first spawn failure even with retries available', () => {
  let callCount = 0;
  const spawn = () => {
    callCount++;
    return { stdout: '', stderr: 'err', status: 1, error: null };
  };
  const result = refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), maxRetries: 2, spawn });
  expect(result).toMatchObject({ ok: false, reason: 'planner_dispatch_failed' });
  expect(callCount).toBe(1);
});

test('refineIdea prepends warning to prompt on retry', () => {
  let prompts = [];
  const spawn = (cmd, args, opts) => {
    prompts.push(args[args.length - 1]);
    if (prompts.length === 1) {
      return { stdout: 'invalid json', stderr: '', status: 0, error: null };
    }
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  refineIdea({ idea: 'add a feature', rootDir: tmpRoot(), maxRetries: 1, spawn });
  expect(prompts.length).toBe(2);
  expect(prompts[1]).toContain('PREVIOUS RESPONSE WAS INVALID JSON');
});

test('buildRepoContext returns empty string when rootDir has no README or CLAUDE.md', () => {
  const rootDir = tmpRoot();
  const result = buildRepoContext(rootDir);
  expect(typeof result).toBe('string');
  expect(result).toContain('Directory tree');
});

test('buildRepoContext includes README.md content up to 2000 chars', () => {
  const rootDir = tmpRoot();
  fs.writeFileSync(path.join(rootDir, 'README.md'), 'a'.repeat(3000), 'utf8');
  const result = buildRepoContext(rootDir);
  expect(result).toContain('README.md');
  expect(result.includes('a'.repeat(2001))).toBe(false);
  expect(result.includes('a'.repeat(1999))).toBe(true);
});

test('buildRepoContext includes CLAUDE.md content up to 2000 chars', () => {
  const rootDir = tmpRoot();
  fs.writeFileSync(path.join(rootDir, 'CLAUDE.md'), 'b'.repeat(2500), 'utf8');
  const result = buildRepoContext(rootDir);
  expect(result).toContain('CLAUDE.md');
  expect(result.includes('b'.repeat(2001))).toBe(false);
});

test('buildRepoContext lists top 2 directory levels excluding .git, .ralph, node_modules', () => {
  const rootDir = tmpRoot();
  fs.mkdirSync(path.join(rootDir, 'src'));
  fs.writeFileSync(path.join(rootDir, 'src', 'index.js'), '', 'utf8');
  fs.mkdirSync(path.join(rootDir, '.git'));
  fs.mkdirSync(path.join(rootDir, '.ralph'));
  fs.mkdirSync(path.join(rootDir, 'node_modules'));
  fs.writeFileSync(path.join(rootDir, 'package.json'), '{}', 'utf8');
  const result = buildRepoContext(rootDir);
  expect(result).toContain('src/');
  expect(result).toContain('index.js');
  expect(result).toContain('package.json');
  expect(result).not.toContain('.git/');
  expect(result).not.toContain('.ralph/');
  expect(result).not.toContain('node_modules/');
});

test('buildRepoContext caps total output at 6000 chars', () => {
  const rootDir = tmpRoot();
  fs.writeFileSync(path.join(rootDir, 'README.md'), 'c'.repeat(3000), 'utf8');
  fs.writeFileSync(path.join(rootDir, 'CLAUDE.md'), 'd'.repeat(3000), 'utf8');
  const result = buildRepoContext(rootDir);
  expect(result.length).toBeLessThanOrEqual(6000);
});

test('buildRepoContext never throws on unreadable rootDir', () => {
  const result = buildRepoContext('/nonexistent/path/that/does/not/exist');
  expect(typeof result).toBe('string');
});

test('refineIdea integrates with buildRepoContext and includes repo context in prompt', () => {
  const rootDir = tmpRoot();
  fs.writeFileSync(path.join(rootDir, 'README.md'), 'Project overview', 'utf8');
  let capturedPrompt;
  const spawn = (cmd, args, opts) => {
    capturedPrompt = args[args.length - 1];
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  refineIdea({ idea: 'add logging', rootDir, spawn });
  expect(capturedPrompt).toContain('Project overview');
  expect(capturedPrompt).toContain('add logging');
});

test('refineIdea trims whitespace from idea before validation and replacement', () => {
  let capturedPrompt;
  const spawn = (cmd, args, opts) => {
    capturedPrompt = args[args.length - 1];
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  refineIdea({ idea: '  add feature  ', rootDir: tmpRoot(), spawn });
  expect(capturedPrompt).toContain('add feature');
  expect(capturedPrompt).not.toContain('  add feature  ');
});

test('refineIdea handles story_spec with extra fields by keeping only required ones', () => {
  const raw = makeValidStdout({ extra_field: 'should be ignored' });
  const result = refineIdea({ idea: 'x', rootDir: tmpRoot(), spawn: makeSpawnSync(raw) });
  expect(result.ok).toBe(true);
  expect(result.story_spec.extra_field).toBeUndefined();
});

test('refineIdea returns planner_invalid_response when title is empty string', () => {
  const spawn = makeSpawnSync(makeValidStdout({ title: '' }));
  const result = refineIdea({ idea: 'x', rootDir: tmpRoot(), spawn });
  expect(result).toMatchObject({ ok: false, reason: 'planner_invalid_response' });
});

test('refineIdea returns planner_invalid_response when recommended_executor is empty', () => {
  const spawn = makeSpawnSync(makeValidStdout({ recommended_executor: '' }));
  const result = refineIdea({ idea: 'x', rootDir: tmpRoot(), spawn });
  expect(result).toMatchObject({ ok: false, reason: 'planner_invalid_response' });
});

test('refineIdea returns planner_invalid_response when reasoning is empty', () => {
  const spawn = makeSpawnSync(makeValidStdout({ reasoning: '' }));
  const result = refineIdea({ idea: 'x', rootDir: tmpRoot(), spawn });
  expect(result).toMatchObject({ ok: false, reason: 'planner_invalid_response' });
});

test('refineIdea uses injected now function when recording cost', () => {
  const fixedDate = new Date('2026-01-01T00:00:00.000Z');
  let seenNow;
  const spawn = (cmd, args, opts) => {
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const result = refineIdea({
    idea: 'x',
    rootDir: tmpRoot(),
    spawn,
    now: () => {
      seenNow = fixedDate;
      return fixedDate;
    }
  });
  expect(result.ok).toBe(true);
  expect(seenNow).toEqual(fixedDate);
});

test('buildRepoContext handles second-level unreadable directories gracefully', () => {
  const rootDir = tmpRoot();
  fs.mkdirSync(path.join(rootDir, 'restricted'), { mode: 0o000 });
  try {
    const result = buildRepoContext(rootDir);
    expect(typeof result).toBe('string');
    expect(result).toContain('restricted/');
  } finally {
    try {
      fs.chmodSync(path.join(rootDir, 'restricted'), 0o755);
      fs.rmdirSync(path.join(rootDir, 'restricted'));
    } catch (_e) {
      // best effort cleanup
    }
  }
});

// ============================================================
// Phase 3 #2 review fixups: opencode invocation flags + case-insensitive FILE 1
// ============================================================

test('Phase 3 #2 review: spawn args use --dir rootDir and pass prompt as final positional', () => {
  // Aligns with src/ralph/opencode-kimi-dispatcher.js. The earlier draft
  // used `--print` (not a documented opencode flag) and omitted --dir
  // (anchoring opencode at process.cwd rather than the project root).
  let seenArgs;
  const spawn = (cmd, args, opts) => {
    seenArgs = args;
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const rootDir = tmpRoot();
  refineIdea({ idea: 'test', rootDir, spawn });
  expect(seenArgs[0]).toBe('run');
  expect(seenArgs[1]).toBe('--model');
  // index 2 is the plannerModel
  expect(seenArgs[3]).toBe('--format');
  expect(seenArgs[4]).toBe('json');
  expect(seenArgs[5]).toBe('--dir');
  expect(seenArgs[6]).toBe(rootDir);
  // prompt is the final positional arg
  expect(typeof seenArgs[7]).toBe('string');
  expect(seenArgs[7]).toContain('test');
  // --print MUST NOT be present anywhere in the args
  expect(seenArgs).not.toContain('--print');
});

test('Phase 3 #2 review: validateStorySpec accepts case variations of FILE 1', () => {
  // Lowercase
  const lowerCase = makeValidStdout({ requirement: 'file 1 (create): make it so' });
  const lowResult = refineIdea({ idea: 'x', rootDir: tmpRoot(), spawn: makeSpawnSync(lowerCase) });
  expect(lowResult.ok).toBe(true);

  // Mixed case
  const mixed = makeValidStdout({ requirement: 'File 1 (CREATE): mixed case' });
  const mixedResult = refineIdea({ idea: 'x', rootDir: tmpRoot(), spawn: makeSpawnSync(mixed) });
  expect(mixedResult.ok).toBe(true);

  // Heading style with whitespace
  const heading = makeValidStdout({ requirement: '## FILE 1 (CREATE) heading style\nbody' });
  const headingResult = refineIdea({ idea: 'x', rootDir: tmpRoot(), spawn: makeSpawnSync(heading) });
  expect(headingResult.ok).toBe(true);

  // No file marker at all → still rejected
  const noFile = makeValidStdout({ requirement: 'just plain instructions without the marker' });
  const noFileResult = refineIdea({ idea: 'x', rootDir: tmpRoot(), spawn: makeSpawnSync(noFile) });
  expect(noFileResult.ok).toBe(false);
  expect(noFileResult.reason).toBe('planner_invalid_response');
});
