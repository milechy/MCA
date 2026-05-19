const { test, expect } = require('@playwright/test');
const {
  parseArgs,
  buildStoryId,
  runSubmitIdea
} = require('../../scripts/ralph/submit-idea');

const { DEFAULT_PLANNER_MODEL } = require('../../src/ralph/idea-refiner');

test('parseArgs reads idea from positional args', () => {
  const argv = ['node', 'submit-idea.js', 'add', 'logging'];
  const result = parseArgs(argv);
  expect(result.idea).toBe('add logging');
});

test('parseArgs picks up --planner-model and --max-retries', () => {
  const argv = ['--planner-model', 'x', '--max-retries', '3'];
  const result = parseArgs(argv);
  expect(result.plannerModel).toBe('x');
  expect(result.maxRetries).toBe(3);
});

test('parseArgs defaults flags correctly', () => {
  const result = parseArgs([]);
  expect(result.plannerModel).toBe(DEFAULT_PLANNER_MODEL);
  expect(result.maxRetries).toBe(1);
  expect(result.mode).toBe('fullauto');
  expect(result.target_env).toBe('local');
  expect(result.yes).toBe(false);
  expect(result.root).toBe(process.cwd());
  expect(result.dry_run).toBe(false);
  expect(result.idea).toBe('');
});

test('parseArgs reads --mode, --target-env, --yes, --root, --dry-run', () => {
  const argv = ['--mode', 'approval', '--target-env', 'staging', '--yes', '--root', '/tmp/root', '--dry-run'];
  const result = parseArgs(argv);
  expect(result.mode).toBe('approval');
  expect(result.target_env).toBe('staging');
  expect(result.yes).toBe(true);
  expect(result.root).toBe('/tmp/root');
  expect(result.dry_run).toBe(true);
});

test('parseArgs ignores unknown flags and collects positional after flags', () => {
  const argv = ['--planner-model', 'm', 'do', 'something'];
  const result = parseArgs(argv);
  expect(result.idea).toBe('do something');
  expect(result.plannerModel).toBe('m');
});

test('parseArgs prefers positional idea over empty stdin', () => {
  const argv = ['build a feature'];
  const result = parseArgs(argv);
  expect(result.idea).toBe('build a feature');
});

test('buildStoryId produces STORY-IDEA-YYYYMMDDHHMMSS-NNNNNN pattern', () => {
  const fixed = new Date('2026-01-15T09:30:45.000Z');
  const id = buildStoryId(fixed);
  expect(id).toMatch(/^STORY-IDEA-\d{14}-\d{6}$/);
  expect(id).toContain('20260115093045');
});

test('buildStoryId uses injected now', () => {
  const now = new Date('2025-12-31T23:59:59.000Z');
  const id = buildStoryId(now);
  expect(id).toContain('20251231235959');
});

test('runSubmitIdea prints USAGE and exits 1 when both argv and stdin are empty', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  await runSubmitIdea({
    argv: [],
    stdin: '',
    stderr: (msg) => stderr.push(msg),
    stdout: (msg) => stdout.push(msg),
    exit: (code) => { exitCode = code; },
    refineIdea: () => ({ ok: false }),
    createStory: () => ({ ok: false }),
    now: new Date()
  });
  expect(exitCode).toBe(1);
  expect(stderr.join('')).toContain('USAGE');
});

test('runSubmitIdea exits 2 and prints failure JSON on refineIdea ok:false', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  await runSubmitIdea({
    argv: ['bad idea'],
    stdin: '',
    stderr: (msg) => stderr.push(msg),
    stdout: (msg) => stdout.push(msg),
    exit: (code) => { exitCode = code; },
    refineIdea: () => ({ ok: false, reason: 'planner_dispatch_failed' }),
    createStory: () => ({ ok: false }),
    now: new Date()
  });
  expect(exitCode).toBe(2);
  const errJson = JSON.parse(stderr.find((s) => s.startsWith('{')) || '{}');
  expect(errJson).toMatchObject({ ok: false, reason: 'planner_dispatch_failed' });
});

test('runSubmitIdea prints preview to stderr on refineIdea success', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  const storySpec = {
    title: 'Test Title',
    difficulty: 'easy',
    recommended_executor: 'openrouter/moonshotai/kimi-k2.6',
    requested_paths: ['src/foo.js'],
    requirement: 'FILE 1 (CREATE): test'
  };
  await runSubmitIdea({
    argv: ['add foo'],
    stdin: '',
    stderr: (msg) => stderr.push(msg),
    stdout: (msg) => stdout.push(msg),
    exit: (code) => { exitCode = code; },
    refineIdea: () => ({
      ok: true,
      story_spec: storySpec,
      planner_cost_usd: 0.005,
      planner_model: 'openrouter/moonshotai/kimi-k2.6'
    }),
    createStory: () => ({ ok: true }),
    now: new Date()
  });
  expect(exitCode).toBe(0);
  const allStderr = stderr.join('');
  expect(allStderr).toContain('Title: Test Title');
  expect(allStderr).toContain('Difficulty: easy');
  expect(allStderr).toContain('Executor: openrouter/moonshotai/kimi-k2.6');
  expect(allStderr).toContain('src/foo.js');
  expect(allStderr).toContain('Planner cost USD: 0.005');
});

test('runSubmitIdea skips prompt and proceeds when --yes is passed', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  const storySpec = {
    title: 'Auto Title',
    difficulty: 'medium',
    recommended_executor: 'x',
    requested_paths: ['a.js'],
    requirement: 'FILE 1 (CREATE): a'
  };
  let created = null;
  await runSubmitIdea({
    argv: ['--yes', 'auto idea'],
    stdin: '',
    stderr: (msg) => stderr.push(msg),
    stdout: (msg) => stdout.push(msg),
    exit: (code) => { exitCode = code; },
    refineIdea: () => ({
      ok: true,
      story_spec: storySpec,
      planner_cost_usd: 0.001,
      planner_model: 'm'
    }),
    createStory: (input) => { created = input; return { ok: true }; },
    now: new Date('2026-05-20T12:00:00.000Z')
  });
  expect(exitCode).toBe(0);
  expect(stderr.join('')).not.toContain('Proceed?');
  expect(created).not.toBeNull();
  expect(created.title).toBe('Auto Title');
});

test('runSubmitIdea skips prompt when stdin is not a TTY', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  const storySpec = {
    title: 'Pipe Title',
    difficulty: 'easy',
    recommended_executor: 'y',
    requested_paths: ['b.js'],
    requirement: 'FILE 1 (CREATE): b'
  };
  let created = null;
  // Simulate non-TTY by setting process.stdin.isTTY = false in global process
  const originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    await runSubmitIdea({
      argv: ['pipe idea'],
      stdin: '',
      stderr: (msg) => stderr.push(msg),
      stdout: (msg) => stdout.push(msg),
      exit: (code) => { exitCode = code; },
      refineIdea: () => ({
        ok: true,
        story_spec: storySpec,
        planner_cost_usd: 0,
        planner_model: 'm2'
      }),
      createStory: (input) => { created = input; return { ok: true }; },
      now: new Date()
    });
  } finally {
    if (originalIsTTY === undefined) {
      delete process.stdin.isTTY;
    } else {
      process.stdin.isTTY = originalIsTTY;
    }
  }
  expect(exitCode).toBe(0);
  expect(stderr.join('')).not.toContain('Proceed?');
  expect(created).not.toBeNull();
});

test('runSubmitIdea prompts and proceeds on Y answer', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  const storySpec = {
    title: 'Prompt Title',
    difficulty: 'hard',
    recommended_executor: 'z',
    requested_paths: ['c.js'],
    requirement: 'FILE 1 (CREATE): c'
  };
  let created = null;
  // Mock stdin by temporarily attaching a fake data listener that resolves synchronously
  const originalOn = process.stdin.on;
  const originalOff = process.stdin.off;
  process.stdin.on = (event, handler) => {
    if (event === 'data') {
      setTimeout(() => handler('Y\n'), 0);
    }
  };
  process.stdin.off = () => {};
  const originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  try {
    await runSubmitIdea({
      argv: ['prompt idea'],
      stdin: '',
      stderr: (msg) => stderr.push(msg),
      stdout: (msg) => stdout.push(msg),
      exit: (code) => { exitCode = code; },
      refineIdea: () => ({
        ok: true,
        story_spec: storySpec,
        planner_cost_usd: 0.01,
        planner_model: 'm3'
      }),
      createStory: (input) => { created = input; return { ok: true }; },
      now: new Date()
    });
  } finally {
    process.stdin.on = originalOn;
    process.stdin.off = originalOff;
    if (originalIsTTY === undefined) {
      delete process.stdin.isTTY;
    } else {
      process.stdin.isTTY = originalIsTTY;
    }
  }
  expect(exitCode).toBe(0);
  expect(stderr.join('')).toContain('Proceed?');
  expect(created).not.toBeNull();
});

test('runSubmitIdea prompts and aborts on n answer with exit 0', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  const storySpec = {
    title: 'Abort Title',
    difficulty: 'trivial',
    recommended_executor: 'w',
    requested_paths: ['d.js'],
    requirement: 'FILE 1 (CREATE): d'
  };
  let created = null;
  const originalOn = process.stdin.on;
  const originalOff = process.stdin.off;
  process.stdin.on = (event, handler) => {
    if (event === 'data') {
      setTimeout(() => handler('n\n'), 0);
    }
  };
  process.stdin.off = () => {};
  const originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  try {
    await runSubmitIdea({
      argv: ['abort idea'],
      stdin: '',
      stderr: (msg) => stderr.push(msg),
      stdout: (msg) => stdout.push(msg),
      exit: (code) => { exitCode = code; },
      refineIdea: () => ({
        ok: true,
        story_spec: storySpec,
        planner_cost_usd: 0.02,
        planner_model: 'm4'
      }),
      createStory: (input) => { created = input; return { ok: true }; },
      now: new Date()
    });
  } finally {
    process.stdin.on = originalOn;
    process.stdin.off = originalOff;
    if (originalIsTTY === undefined) {
      delete process.stdin.isTTY;
    } else {
      process.stdin.isTTY = originalIsTTY;
    }
  }
  expect(exitCode).toBe(0);
  expect(stderr.join('')).toContain('Aborted by user');
  expect(created).toBeNull();
});

test('runSubmitIdea prints story_spec JSON and exits 0 on --dry-run', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  const storySpec = {
    title: 'Dry Title',
    difficulty: 'easy',
    recommended_executor: 'e',
    requested_paths: ['e.js'],
    requirement: 'FILE 1 (CREATE): e'
  };
  await runSubmitIdea({
    argv: ['--dry-run', 'dry idea'],
    stdin: '',
    stderr: (msg) => stderr.push(msg),
    stdout: (msg) => stdout.push(msg),
    exit: (code) => { exitCode = code; },
    refineIdea: () => ({
      ok: true,
      story_spec: storySpec,
      planner_cost_usd: 0,
      planner_model: 'm5'
    }),
    createStory: () => ({ ok: true }),
    now: new Date()
  });
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout.join(''));
  expect(parsed).toMatchObject(storySpec);
});

test('runSubmitIdea calls createStory with correct shape on confirm', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  const storySpec = {
    title: 'Shape Title',
    difficulty: 'medium',
    recommended_executor: 'openrouter/anthropic/claude-sonnet-4.6',
    requested_paths: ['src/shape.js', 'tests/shape.spec.js'],
    requirement: 'FILE 1 (CREATE): src/shape.js\nFILE 2 (CREATE): tests/shape.spec.js'
  };
  let created = null;
  await runSubmitIdea({
    argv: ['--yes', '--mode', 'approval', '--target-env', 'staging', '--root', '/tmp/shape', 'shape idea'],
    stdin: '',
    stderr: (msg) => stderr.push(msg),
    stdout: (msg) => stdout.push(msg),
    exit: (code) => { exitCode = code; },
    refineIdea: () => ({
      ok: true,
      story_spec: storySpec,
      planner_cost_usd: 0.003,
      planner_model: 'openrouter/anthropic/claude-sonnet-4.6'
    }),
    createStory: (input) => { created = input; return { ok: true }; },
    now: new Date('2026-05-20T12:00:00.000Z')
  });
  expect(exitCode).toBe(0);
  expect(created).not.toBeNull();
  expect(created.story_id).toMatch(/^STORY-IDEA-/);
  expect(created.title).toBe('Shape Title');
  expect(created.requirement).toBe(storySpec.requirement);
  expect(created.requested_paths).toEqual(storySpec.requested_paths);
  expect(created.mode).toBe('approval');
  expect(created.target_env).toBe('staging');
  expect(created.priority).toBe(50);
  expect(created.max_attempts).toBe(3);
  expect(created.executor_model).toBe(storySpec.recommended_executor);
  expect(created.difficulty).toBe('medium');
  expect(created.planner_model).toBe('openrouter/anthropic/claude-sonnet-4.6');
  expect(created.planner_cost_usd).toBe(0.003);
  expect(created.risk).toMatchObject({ score: 2, category: 'low', label: 'RISK_2_SOURCE_CODE' });
});

test('runSubmitIdea prints { ok:true, story_id } on createStory success', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  const storySpec = {
    title: 'Success Title',
    difficulty: 'easy',
    recommended_executor: 'e1',
    requested_paths: ['f.js'],
    requirement: 'FILE 1 (CREATE): f'
  };
  await runSubmitIdea({
    argv: ['--yes', 'success idea'],
    stdin: '',
    stderr: (msg) => stderr.push(msg),
    stdout: (msg) => stdout.push(msg),
    exit: (code) => { exitCode = code; },
    refineIdea: () => ({
      ok: true,
      story_spec: storySpec,
      planner_cost_usd: 0,
      planner_model: 'm6'
    }),
    createStory: (input) => ({ ok: true, story_id: input.story_id }),
    now: new Date('2026-05-20T12:00:00.000Z')
  });
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout.join(''));
  expect(parsed.ok).toBe(true);
  expect(parsed.story_id).toMatch(/^STORY-IDEA-/);
});

test('runSubmitIdea prints error JSON to stderr and exits 3 on createStory failure', async () => {
  const stderr = [];
  const stdout = [];
  let exitCode = null;
  const storySpec = {
    title: 'Fail Title',
    difficulty: 'easy',
    recommended_executor: 'e2',
    requested_paths: ['g.js'],
    requirement: 'FILE 1 (CREATE): g'
  };
  await runSubmitIdea({
    argv: ['--yes', 'fail idea'],
    stdin: '',
    stderr: (msg) => stderr.push(msg),
    stdout: (msg) => stdout.push(msg),
    exit: (code) => { exitCode = code; },
    refineIdea: () => ({
      ok: true,
      story_spec: storySpec,
      planner_cost_usd: 0,
      planner_model: 'm7'
    }),
    createStory: () => ({ ok: false, reason: 'disk_full', stage: 'story_queue_create' }),
    now: new Date()
  });
  expect(exitCode).toBe(3);
  const errJson = JSON.parse(stderr.find((s) => s.startsWith('{')) || '{}');
  expect(errJson).toMatchObject({ ok: false, reason: 'disk_full', stage: 'story_queue_create' });
});
