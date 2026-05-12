const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory, STORY_STATUSES } = require('../../src/ralph/story-queue');
const { main } = require('../../src/ralph/cli');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-runtime-operator-cli-'));
}

function captureMain(argv, options = {}) {
  const lines = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (value) => lines.push(String(value));
  try {
    main(argv, options);
  } finally {
    console.log = originalLog;
  }
  const exitCode = process.exitCode || 0;
  process.exitCode = originalExitCode;
  return { exitCode, output: lines.join('\n'), json: lines.length ? JSON.parse(lines.join('\n')) : null };
}

function seedStory(rootDir, overrides = {}) {
  const created = createStory({
    story_id: 'STORY-CLI',
    title: 'Runtime CLI test',
    requirement: 'Validate runtime operator CLI commands.',
    status: STORY_STATUSES.RUNNING,
    current_phase: 'OPENCODE_RUNNING',
    requested_paths: ['docs/cli-resume.md'],
    ...overrides
  }, { rootDir, now: new Date('2026-05-12T00:00:00.000Z') });
  expect(created.ok).toBe(true);
  return created.story;
}

function writePatch(rootDir, rel = '.ralph/tmp/opencode-sandbox/APR-CLI/candidate.patch') {
  const abs = path.join(rootDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, [
    'diff --git a/docs/cli-resume.md b/docs/cli-resume.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/docs/cli-resume.md',
    '@@ -0,0 +1 @@',
    '+cli resume',
    ''
  ].join('\n'), 'utf8');
  return rel;
}

test('story-status CLI prints bounded JSON', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { blocked_reason: 'provider_rate_limited\nREDACT_ME_FAKE_TOKEN_VALUE' });

  const result = captureMain(['story-status', 'STORY-CLI'], { rootDir, now: new Date('2026-05-12T00:10:00.000Z') });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    ok: true,
    stage: 'ralph_story_status',
    story_id: 'STORY-CLI',
    story: { story_id: 'STORY-CLI', current_phase: 'OPENCODE_RUNNING' }
  });
});

test('resume-with-candidate-patch CLI moves story to PATCH_PREVIEW', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { retry_after_at: '2026-05-12T01:00:00.000Z' });
  const patchPath = writePatch(rootDir);

  const result = captureMain(['resume-with-candidate-patch', 'STORY-CLI', patchPath], {
    rootDir,
    now: new Date('2026-05-12T00:20:00.000Z')
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    ok: true,
    stage: 'ralph_resume_with_candidate_patch',
    story_id: 'STORY-CLI',
    candidate_patch_path: patchPath,
    next_action: 'preview_candidate_patch_and_decide_apply'
  });
  expect(readStory(rootDir, 'STORY-CLI')).toMatchObject({
    status: STORY_STATUSES.RUNNING,
    current_phase: 'PATCH_PREVIEW',
    current_candidate_patch_path: patchPath,
    retry_after_at: null
  });
});

test('explain-runnable CLI returns non-zero for missing story through ok false JSON', () => {
  const rootDir = tmpRoot();

  const result = captureMain(['explain-runnable', 'STORY-MISSING'], { rootDir });

  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({ ok: false, reason: 'story_not_found', story_id: 'STORY-MISSING' });
});
