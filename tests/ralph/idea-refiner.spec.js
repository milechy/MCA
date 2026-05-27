const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PLANNER_PROMPT_TEMPLATE,
  DEFAULT_PLANNER_MODEL,
  DEFAULT_MAX_RETRIES,
  refineIdea,
  buildRepoContext,
  extractPlannerJson,
  stripCodeFence
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
  // Phase 8 #2: switched from Claude Sonnet 4.6 to DeepSeek V3 (chat).
  // See the comment on DEFAULT_PLANNER_MODEL in src/ralph/idea-refiner.js
  // for the smoke comparison data and rationale.
  expect(DEFAULT_PLANNER_MODEL).toBe('openrouter/deepseek/deepseek-chat');
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

test('Phase 3 #2 review + Phase 4 #2.1: spawn args use --dir <plannerSandbox> (not rootDir) and pass prompt as final positional', () => {
  // Phase 3 #2 review: aligns with src/ralph/opencode-kimi-dispatcher.js
  // for the shape (run --model … --format json --dir … <prompt>).
  // Phase 4 #2.1: --dir now points at an injectable isolated sandbox dir,
  // NOT rootDir. This prevents a rogue planner from writing files into
  // the project worktree via opencode's file-write tools (smoke caught
  // Claude doing exactly that when the idea text said "create a new file").
  let seenArgs;
  const spawn = (cmd, args, opts) => {
    seenArgs = args;
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const rootDir = tmpRoot();
  const sandboxDir = '/tmp/ralph-planner-fake-sandbox';
  refineIdea({
    idea: 'test',
    rootDir,
    spawn,
    makeSandboxDir: () => sandboxDir,
    cleanupSandboxDir: () => {}
  });
  expect(seenArgs[0]).toBe('run');
  expect(seenArgs[1]).toBe('--model');
  // index 2 is the plannerModel
  expect(seenArgs[3]).toBe('--format');
  expect(seenArgs[4]).toBe('json');
  expect(seenArgs[5]).toBe('--dir');
  expect(seenArgs[6]).toBe(sandboxDir);
  expect(seenArgs[6]).not.toBe(rootDir);
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

// ---------------------------------------------------------------------------
// Phase 3 E2E fix: extractPlannerJson + stripCodeFence
// ---------------------------------------------------------------------------

test('Phase 3 E2E: stripCodeFence strips ```json fences', () => {
  expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  expect(stripCodeFence('  ```json\n{"a":1}\n```  ')).toBe('{"a":1}');
});

test('Phase 3 E2E: stripCodeFence is a no-op when there is no fence', () => {
  expect(stripCodeFence('plain text')).toBe('plain text');
  expect(stripCodeFence('')).toBe('');
  expect(stripCodeFence(null)).toBe('');
  expect(stripCodeFence(undefined)).toBe('');
});

test('Phase 3 E2E: extractPlannerJson handles pure JSON (legacy unit-test shape)', () => {
  const stdout = JSON.stringify({ title: 'X', foo: 'bar' });
  const result = extractPlannerJson(stdout);
  expect(result).toEqual({ title: 'X', foo: 'bar' });
});

test('Phase 3 E2E: extractPlannerJson handles opencode NDJSON streaming envelope', () => {
  // Real shape observed from `opencode run --format json` against Claude.
  const lines = [
    JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_1', part: { id: 'p1', type: 'step-start' } }),
    JSON.stringify({
      type: 'text',
      timestamp: 2,
      part: {
        id: 'p2',
        type: 'text',
        text: '```json\n{\n  "title": "From stream",\n  "value": 42\n}\n```'
      }
    }),
    JSON.stringify({ type: 'step_finish', timestamp: 3, part: { id: 'p3' } })
  ];
  const stdout = lines.join('\n') + '\n';
  const result = extractPlannerJson(stdout);
  expect(result).toEqual({ title: 'From stream', value: 42 });
});

test('Phase 3 E2E: extractPlannerJson concatenates text from multiple text events', () => {
  // Some opencode runs split the assistant message across multiple text deltas.
  const lines = [
    JSON.stringify({ type: 'text', part: { type: 'text', text: '```json\n{"title":' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: '"split","n":1}\n```' } })
  ];
  const stdout = lines.join('\n');
  const result = extractPlannerJson(stdout);
  expect(result).toEqual({ title: 'split', n: 1 });
});

test('Phase 3 E2E: extractPlannerJson returns null on empty / non-parsable / no-text input', () => {
  expect(extractPlannerJson('')).toBe(null);
  expect(extractPlannerJson(null)).toBe(null);
  expect(extractPlannerJson(undefined)).toBe(null);
  // NDJSON with only step events, no text → null
  const onlySteps = [
    JSON.stringify({ type: 'step_start', part: {} }),
    JSON.stringify({ type: 'step_finish', part: {} })
  ].join('\n');
  expect(extractPlannerJson(onlySteps)).toBe(null);
  // Text event with unparsable JSON inside the fence → null
  const bad = JSON.stringify({ type: 'text', part: { type: 'text', text: '```json\nnot json at all\n```' } });
  expect(extractPlannerJson(bad)).toBe(null);
});

test('Phase 3 E2E: refineIdea works against real opencode streaming envelope (regression for planner_invalid_response)', () => {
  // This is the bug that the Phase 3 E2E smoke uncovered: opencode emits
  // NDJSON, not pure JSON, so the previous JSON.parse(stdout) failed.
  const validSpec = {
    title: 'Streaming test',
    requirement: 'FILE 1 (CREATE): docs/streamed.md\nCreate a doc with one line.',
    requested_paths: ['docs/streamed.md'],
    difficulty: 'trivial',
    recommended_executor: 'openrouter/moonshotai/kimi-k2.6',
    reasoning: 'Trivial single-file creation.'
  };
  const lines = [
    JSON.stringify({ type: 'step_start', part: { id: 'p1' } }),
    JSON.stringify({
      type: 'text',
      part: { id: 'p2', type: 'text', text: '```json\n' + JSON.stringify(validSpec, null, 2) + '\n```' }
    }),
    JSON.stringify({ type: 'step_finish', part: { id: 'p3' } })
  ];
  const stdout = lines.join('\n');
  const result = refineIdea({
    idea: 'create a streamed doc',
    rootDir: tmpRoot(),
    spawn: makeSpawnSync(stdout)
  });
  expect(result.ok).toBe(true);
  expect(result.story_spec.title).toBe('Streaming test');
  expect(result.story_spec.requested_paths).toEqual(['docs/streamed.md']);
});

// ============================================================
// Phase 4 #2.1: planner side-effect isolation
// ============================================================

test('Phase 4 #2.1: PLANNER_PROMPT_TEMPLATE forbids file writes', () => {
  // Smoke caught Claude using opencode file-write tools because the idea
  // said "create a new file ...". The template now states the planning-only
  // contract loudly enough that the model cannot miss it.
  expect(PLANNER_PROMPT_TEMPLATE).toContain('PLANNING ONLY');
  expect(PLANNER_PROMPT_TEMPLATE).toMatch(/DO NOT (write|create)/i);
  expect(PLANNER_PROMPT_TEMPLATE).toContain('executor');
});

test('Phase 4 #2.1: refineIdea creates a sandbox dir, passes it as --dir, and cleans up on success', () => {
  let createdDir = null;
  let cleanedDir = null;
  const spawn = (cmd, args) => {
    // index 6 is the --dir value
    expect(args[5]).toBe('--dir');
    expect(args[6]).toBe(createdDir);
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const result = refineIdea({
    idea: 'something',
    rootDir: tmpRoot(),
    spawn,
    makeSandboxDir: () => { createdDir = '/tmp/ralph-planner-test-sandbox-' + Math.random(); return createdDir; },
    cleanupSandboxDir: (dir) => { cleanedDir = dir; }
  });
  expect(result.ok).toBe(true);
  expect(cleanedDir).toBe(createdDir);
});

test('Phase 4 #2.1: refineIdea cleans up sandbox dir even when planner fails', () => {
  let createdDir = null;
  let cleanedDir = null;
  const result = refineIdea({
    idea: 'fail me',
    rootDir: tmpRoot(),
    spawn: () => ({ stdout: '', stderr: 'boom', status: 1, error: new Error('boom') }),
    makeSandboxDir: () => { createdDir = '/tmp/ralph-planner-failtest'; return createdDir; },
    cleanupSandboxDir: (dir) => { cleanedDir = dir; }
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('planner_dispatch_failed');
  // Cleanup MUST run even on the failure return path.
  expect(cleanedDir).toBe(createdDir);
});

test('Phase 4 #2.1: refineIdea cleans up sandbox dir when planner returns invalid JSON across all retries', () => {
  let cleanedDir = null;
  const result = refineIdea({
    idea: 'will never parse',
    rootDir: tmpRoot(),
    spawn: () => ({ stdout: 'definitely not json', stderr: '', status: 0, error: null }),
    maxRetries: 0,
    makeSandboxDir: () => '/tmp/ralph-planner-invalid-json',
    cleanupSandboxDir: (dir) => { cleanedDir = dir; }
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('planner_invalid_response');
  expect(cleanedDir).toBe('/tmp/ralph-planner-invalid-json');
});

test('Phase 4 #2.1: makePlannerSandboxDir actually creates a real tmpdir; cleanupPlannerSandboxDir removes it', () => {
  const { makePlannerSandboxDir, cleanupPlannerSandboxDir } = require('../../src/ralph/idea-refiner');
  const dir = makePlannerSandboxDir(new Date('2026-05-20T12:34:56Z'));
  expect(fs.existsSync(dir)).toBe(true);
  expect(dir).toContain('ralph-planner-');
  // Write a marker file to prove the dir is real and writable.
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'x');
  expect(fs.existsSync(path.join(dir, 'marker.txt'))).toBe(true);
  cleanupPlannerSandboxDir(dir);
  expect(fs.existsSync(dir)).toBe(false);
});

test('Phase 4 #2.1: cleanupPlannerSandboxDir is a no-op on null/undefined/missing dir (best-effort cleanup)', () => {
  const { cleanupPlannerSandboxDir } = require('../../src/ralph/idea-refiner');
  // Each of these must not throw.
  cleanupPlannerSandboxDir(null);
  cleanupPlannerSandboxDir(undefined);
  cleanupPlannerSandboxDir('/nonexistent/path/that/does/not/exist/' + Math.random());
});

// ============================================================
// Phase 6 #3: defense-in-depth — spawnSync cwd is the sandbox too
// ============================================================
//
// Phase 4 #2.1 set opencode's --dir to a throwaway tmpdir. That covers
// opencode-aware path resolution. But opencode is an agent shell — the
// planner Claude can invoke Bash/Write/etc tools. If any of those tools
// resolve relative paths against process.cwd() (the spawned child's cwd,
// which inherits from the parent), and the parent cwd is the project
// root, a rogue write lands in the project worktree. Phase 5 #7 smoke
// saw an orphan there; the real cause was traced to the FIX_LOOP
// rollback gap (fixed in #167), but #3 pins the planner side so any
// future opencode-tool change can't reopen the same window.

test('Phase 6 #3: refineIdea spawns opencode with cwd set to the sandbox dir (not the parent cwd)', () => {
  let seenOpts = null;
  const spawn = (cmd, args, opts) => {
    seenOpts = opts;
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const fakeSandbox = '/tmp/ralph-planner-cwd-test-' + Math.random().toString(36).slice(2);
  refineIdea({
    idea: 'whatever',
    rootDir: tmpRoot(),
    spawn,
    makeSandboxDir: () => fakeSandbox,
    cleanupSandboxDir: () => {}
  });
  expect(seenOpts).toBeTruthy();
  expect(seenOpts.cwd).toBe(fakeSandbox);
  // Critically: cwd must NOT be the parent process's cwd / rootDir.
  expect(seenOpts.cwd).not.toBe(process.cwd());
});

test('Phase 6 #3: spawnSync cwd === --dir for the planner (both point at the same sandbox)', () => {
  let seenArgs = null;
  let seenOpts = null;
  const spawn = (cmd, args, opts) => {
    seenArgs = args;
    seenOpts = opts;
    return { stdout: makeValidStdout(), stderr: '', status: 0, error: null };
  };
  const fakeSandbox = '/tmp/ralph-planner-symmetry-test';
  refineIdea({
    idea: 'symmetry',
    rootDir: tmpRoot(),
    spawn,
    makeSandboxDir: () => fakeSandbox,
    cleanupSandboxDir: () => {}
  });
  // Args layout: ['run', '--model', <model>, '--format', 'json', '--dir', <sandbox>, <prompt>]
  const dirArgIndex = seenArgs.indexOf('--dir');
  expect(dirArgIndex).toBeGreaterThan(-1);
  expect(seenArgs[dirArgIndex + 1]).toBe(fakeSandbox);
  expect(seenOpts.cwd).toBe(seenArgs[dirArgIndex + 1]);
});

// ============================================================
// DEFAULT_REPO_CONTEXT_CAP export + cap regression tests
// ============================================================

test('DEFAULT_REPO_CONTEXT_CAP is exported and equals 6000', () => {
  const { DEFAULT_REPO_CONTEXT_CAP } = require('../../src/ralph/idea-refiner');
  expect(DEFAULT_REPO_CONTEXT_CAP).toStrictEqual(6000);
});

test('buildRepoContext output length does not exceed DEFAULT_REPO_CONTEXT_CAP', () => {
  const { DEFAULT_REPO_CONTEXT_CAP } = require('../../src/ralph/idea-refiner');
  const rootDir = tmpRoot();
  // Write enough content so the cap logic is actually exercised.
  fs.writeFileSync(path.join(rootDir, 'README.md'), 'x'.repeat(3000), 'utf8');
  fs.writeFileSync(path.join(rootDir, 'CLAUDE.md'), 'y'.repeat(3000), 'utf8');
  const result = buildRepoContext(rootDir);
  expect(result.length).toBeLessThanOrEqual(DEFAULT_REPO_CONTEXT_CAP);
});

test('PLANNER_PROMPT_TEMPLATE and refineIdea exports still exist', () => {
  const { PLANNER_PROMPT_TEMPLATE: tpl, refineIdea: fn } = require('../../src/ralph/idea-refiner');
  expect(tpl).not.toBeUndefined();
  expect(tpl).not.toBeNull();
  expect(fn).not.toBeUndefined();
  expect(fn).not.toBeNull();
});
