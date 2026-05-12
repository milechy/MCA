const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory, STORY_STATUSES } = require('../../src/ralph/story-queue');
const { writeExternalAgentJob } = require('../../src/ralph/external-agent-jobs');
const {
  storyStatus,
  explainRunnable,
  resumeWithCandidatePatch,
  cleanupStoryRuntime,
  resetStoryRuntime
} = require('../../src/ralph/runtime-operator');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-runtime-operator-'));
}

function seedStory(rootDir, overrides = {}) {
  const created = createStory({
    story_id: 'STORY-RUNTIME',
    title: 'Runtime operator test',
    requirement: 'Validate runtime operator commands.',
    status: STORY_STATUSES.RUNNING,
    current_phase: 'OPENCODE_RUNNING',
    requested_paths: ['docs/runtime-resume.md'],
    ...overrides
  }, { rootDir, now: new Date('2026-05-12T00:00:00.000Z') });
  expect(created.ok).toBe(true);
  return created.story;
}

function writePatch(rootDir, rel = '.ralph/tmp/opencode-sandbox/APR-RUNTIME/candidate.patch') {
  const abs = path.join(rootDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, [
    'diff --git a/docs/runtime-resume.md b/docs/runtime-resume.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/docs/runtime-resume.md',
    '@@ -0,0 +1 @@',
    '+runtime resume',
    ''
  ].join('\n'), 'utf8');
  return rel;
}

test('storyStatus returns bounded runtime summary', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { current_job_id: 'JOB-OPENCODE-AUTO-RUNTIME', blocked_reason: 'provider_rate_limited\nsecret REDACT_ME_FAKE_TOKEN_VALUE' });

  const result = storyStatus({ rootDir, story_id: 'STORY-RUNTIME' });

  expect(result).toMatchObject({
    ok: true,
    stage: 'ralph_story_status',
    story_id: 'STORY-RUNTIME',
    story: {
      story_id: 'STORY-RUNTIME',
      status: STORY_STATUSES.RUNNING,
      current_phase: 'OPENCODE_RUNNING',
      current_job_id: 'JOB-OPENCODE-AUTO-RUNTIME'
    },
    next_action: 'inspect_runnable_or_tick_story'
  });
});

test('explainRunnable reports active retry backoff', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { retry_after_at: '2026-05-12T01:00:00.000Z' });

  const result = explainRunnable({ rootDir, story_id: 'STORY-RUNTIME', now: new Date('2026-05-12T00:30:00.000Z') });

  expect(result).toMatchObject({
    ok: true,
    stage: 'ralph_explain_runnable',
    story_id: 'STORY-RUNTIME',
    runnable: false,
    reasons: ['retry_backoff_active'],
    retry_after_at: '2026-05-12T01:00:00.000Z',
    next_action: 'resolve_runnable_blockers'
  });
});

test('resumeWithCandidatePatch moves story to PATCH_PREVIEW without editing repository files', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir, { retry_after_at: '2026-05-12T01:00:00.000Z', blocked_reason: 'provider_rate_limited' });
  const patchPath = writePatch(rootDir);

  const result = resumeWithCandidatePatch({
    rootDir,
    story_id: 'STORY-RUNTIME',
    candidate_patch_path: patchPath,
    now: new Date('2026-05-12T00:40:00.000Z')
  });

  expect(result).toMatchObject({
    ok: true,
    stage: 'ralph_resume_with_candidate_patch',
    story_id: 'STORY-RUNTIME',
    candidate_patch_path: patchPath,
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-RUNTIME',
    patch_source: 'operator_seeded_candidate_patch',
    files_touched: ['docs/runtime-resume.md'],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    next_action: 'preview_candidate_patch_and_decide_apply'
  });
  expect(fs.existsSync(path.join(rootDir, 'docs/runtime-resume.md'))).toBe(false);
  expect(readStory(rootDir, 'STORY-RUNTIME')).toMatchObject({
    status: STORY_STATUSES.RUNNING,
    current_phase: 'PATCH_PREVIEW',
    current_candidate_patch_path: patchPath,
    current_sandbox_root: '.ralph/tmp/opencode-sandbox/APR-RUNTIME',
    blocked_reason: null,
    retry_after_at: null,
    patch_source: 'operator_seeded_candidate_patch'
  });
});

test('resumeWithCandidatePatch refuses paths outside .ralph/tmp', () => {
  const rootDir = tmpRoot();
  seedStory(rootDir);
  fs.writeFileSync(path.join(rootDir, 'candidate.patch'), 'diff --git a/a b/a\n--- /dev/null\n+++ b/a\n', 'utf8');

  const result = resumeWithCandidatePatch({ rootDir, story_id: 'STORY-RUNTIME', candidate_patch_path: 'candidate.patch' });

  expect(result).toMatchObject({
    ok: false,
    reason: 'candidate_patch_path_not_allowed',
    next_action: 'provide_candidate_patch_under_ralph_tmp'
  });
  expect(readStory(rootDir, 'STORY-RUNTIME')).toMatchObject({ current_phase: 'OPENCODE_RUNNING' });
});

test('cleanupStoryRuntime removes only targeted runtime artifacts by default', () => {
  const rootDir = tmpRoot();
  const patchPath = writePatch(rootDir);
  seedStory(rootDir, {
    current_job_id: 'JOB-OPENCODE-AUTO-RUNTIME',
    current_approval_id: 'APR-RUNTIME',
    current_sandbox_root: '.ralph/tmp/opencode-sandbox/APR-RUNTIME',
    current_candidate_patch_path: patchPath
  });
  writeExternalAgentJob(rootDir, {
    job_id: 'JOB-OPENCODE-AUTO-RUNTIME',
    status: 'failed',
    approval_id: 'APR-RUNTIME',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-RUNTIME',
    candidate_patch_path: patchPath
  });
  writeExternalAgentJob(rootDir, {
    job_id: 'JOB-OPENCODE-AUTO-OTHER',
    status: 'failed',
    approval_id: 'APR-OTHER',
    sandbox_root: '.ralph/tmp/opencode-sandbox/APR-OTHER',
    candidate_patch_path: '.ralph/tmp/opencode-sandbox/APR-OTHER/candidate.patch'
  });

  const result = cleanupStoryRuntime({ rootDir, story_id: 'STORY-RUNTIME' });

  expect(result.ok).toBe(true);
  expect(result.removed).toEqual(expect.arrayContaining([
    '.ralph/external-agent-jobs/JOB-OPENCODE-AUTO-RUNTIME.json',
    '.ralph/tmp/opencode-sandbox/APR-RUNTIME'
  ]));
  expect(fs.existsSync(path.join(rootDir, '.ralph/external-agent-jobs/JOB-OPENCODE-AUTO-RUNTIME.json'))).toBe(false);
  expect(fs.existsSync(path.join(rootDir, '.ralph/tmp/opencode-sandbox/APR-RUNTIME'))).toBe(false);
  expect(fs.existsSync(path.join(rootDir, '.ralph/external-agent-jobs/JOB-OPENCODE-AUTO-OTHER.json'))).toBe(true);
  expect(fs.existsSync(path.join(rootDir, '.ralph/stories/STORY-RUNTIME.json'))).toBe(true);
});

test('resetStoryRuntime clears runtime metadata and returns story to PLAN', () => {
  const rootDir = tmpRoot();
  const patchPath = writePatch(rootDir);
  seedStory(rootDir, {
    status: STORY_STATUSES.WAITING_APPROVAL,
    current_phase: 'PATCH_PREVIEW',
    current_approval_id: 'APR-RUNTIME',
    current_job_id: 'JOB-OPENCODE-AUTO-RUNTIME',
    current_candidate_patch_path: patchPath,
    current_sandbox_root: '.ralph/tmp/opencode-sandbox/APR-RUNTIME',
    retry_after_at: '2026-05-12T01:00:00.000Z',
    patch_source: 'operator_seeded_candidate_patch'
  });

  const result = resetStoryRuntime({ rootDir, story_id: 'STORY-RUNTIME', now: new Date('2026-05-12T00:50:00.000Z') });

  expect(result).toMatchObject({
    ok: true,
    stage: 'ralph_reset_story_runtime',
    story_id: 'STORY-RUNTIME',
    next_action: 'run_ultraplan_for_story'
  });
  expect(readStory(rootDir, 'STORY-RUNTIME')).toMatchObject({
    status: STORY_STATUSES.QUEUED,
    current_phase: 'PLAN',
    current_approval_id: null,
    current_job_id: null,
    current_candidate_patch_path: null,
    current_sandbox_root: null,
    retry_after_at: null,
    patch_source: null
  });
});
