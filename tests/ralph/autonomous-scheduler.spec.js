const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStory, readStory } = require('../../src/ralph/story-queue');
const { priorityScore, sortStoriesByPriority } = require('../../src/ralph/story-priority');
const { importGitHubIssuesAsStories, storyIdForIssue } = require('../../src/ralph/github-issue-queue');
const { isRunnableStory, selectRunnableStories, schedulerTick, storyBackoffActive } = require('../../src/ralph/autonomous-scheduler');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autonomous-scheduler-'));
}

function seed(rootDir, story) {
  const created = createStory({
    requirement: 'implement scheduler test',
    mode: 'fullauto',
    target_env: 'local',
    ...story
  }, { rootDir, now: new Date(story.created_at || '2026-05-08T17:00:00.000Z') });
  expect(created.ok).toBe(true);
  return created.story;
}

test('story priority sorts urgent runnable work before normal work', () => {
  const stories = [
    { story_id: 'STORY-NORMAL', status: 'queued', labels: [] },
    { story_id: 'STORY-URGENT', status: 'queued', labels: ['urgent'] },
    { story_id: 'STORY-BLOCKED', status: 'queued', labels: ['blocked'] }
  ];
  expect(priorityScore(stories[1])).toBeLessThan(priorityScore(stories[0]));
  expect(sortStoriesByPriority(stories).map((story) => story.story_id)).toEqual(['STORY-URGENT', 'STORY-NORMAL', 'STORY-BLOCKED']);
});

test('GitHub issue queue imports issues as stories and skips duplicates', () => {
  const rootDir = tmpRoot();
  expect(storyIdForIssue({ number: 12 })).toBe('STORY-GH-12');
  const first = importGitHubIssuesAsStories([
    { number: 12, title: 'Add autonomous scheduler', body: 'Please add scheduler loop', labels: [{ name: 'urgent' }], html_url: 'https://example.test/issues/12' }
  ], { rootDir, now: new Date('2026-05-08T17:00:00.000Z'), mode: 'fullauto', target_env: 'local' });
  expect(first).toMatchObject({ ok: true, stage: 'github_issue_queue_import', execution_connected: false, commands_executed: [], repository_files_modified: [] });
  expect(first.imported).toHaveLength(1);
  expect(first.imported[0].story_id).toBe('STORY-GH-12');
  expect(readStory(rootDir, 'STORY-GH-12')).toMatchObject({ story_id: 'STORY-GH-12', status: 'queued', mode: 'fullauto', target_env: 'local' });

  const second = importGitHubIssuesAsStories([{ number: 12, title: 'Add autonomous scheduler' }], { rootDir });
  expect(second.imported).toHaveLength(0);
  expect(second.skipped).toEqual([{ story_id: 'STORY-GH-12', reason: 'story_already_exists', issue_number: 12 }]);
});

test('scheduler selects runnable stories by priority and includes waiting approval resume work', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { story_id: 'STORY-NORMAL', labels: [], created_at: '2026-05-08T17:00:00.000Z' });
  seed(rootDir, { story_id: 'STORY-URGENT', labels: ['urgent'], created_at: '2026-05-08T17:01:00.000Z' });
  seed(rootDir, { story_id: 'STORY-WAITING', status: 'waiting_approval', current_phase: 'PLAN_APPROVAL_PENDING' });
  seed(rootDir, { story_id: 'STORY-DONE', status: 'completed', current_phase: 'DONE' });

  expect(isRunnableStory(readStory(rootDir, 'STORY-NORMAL'))).toBe(true);
  expect(isRunnableStory(readStory(rootDir, 'STORY-WAITING'))).toBe(true);
  expect(isRunnableStory(readStory(rootDir, 'STORY-DONE'))).toBe(false);
  expect(selectRunnableStories({ rootDir, limit: 3 }).map((story) => story.story_id)).toEqual(['STORY-URGENT', 'STORY-NORMAL', 'STORY-WAITING']);
});

test('scheduler skips rate-limited stories until retry_after_at', () => {
  const rootDir = tmpRoot();
  const now = new Date('2026-05-08T17:00:00.000Z');
  seed(rootDir, { story_id: 'STORY-BACKOFF', status: 'running', current_phase: 'OPENCODE_RUNNING', retry_after_at: '2026-05-08T17:10:00.000Z' });
  seed(rootDir, { story_id: 'STORY-READY', status: 'running', current_phase: 'OPENCODE_RUNNING' });
  seed(rootDir, { story_id: 'STORY-EXPIRED-BACKOFF', status: 'running', current_phase: 'OPENCODE_RUNNING', retry_after_at: '2026-05-08T16:59:00.000Z' });

  expect(storyBackoffActive(readStory(rootDir, 'STORY-BACKOFF'), now)).toBe(true);
  expect(isRunnableStory(readStory(rootDir, 'STORY-BACKOFF'), { now })).toBe(false);
  expect(isRunnableStory(readStory(rootDir, 'STORY-EXPIRED-BACKOFF'), { now })).toBe(true);
  expect(selectRunnableStories({ rootDir, limit: 3, now }).map((story) => story.story_id)).toEqual(['STORY-READY', 'STORY-EXPIRED-BACKOFF']);
});

test('schedulerTick advances selected stories without mutating repository directly', () => {
  const rootDir = tmpRoot();
  seed(rootDir, { story_id: 'STORY-SCHED', mode: 'fullauto', current_phase: 'PLAN' });

  const result = schedulerTick({ rootDir, now: new Date('2026-05-08T17:02:00.000Z'), limit: 1, ticks_per_story: 1 });

  expect(result).toMatchObject({
    ok: true,
    stage: 'autonomous_scheduler_tick',
    version: 'autonomous_scheduler_v0_1',
    selected_count: 1,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: 'continue_scheduler_or_review_blocked_stories'
  });
  expect(result.results[0].ticks[0]).toMatchObject({ story_id: 'STORY-SCHED', from_phase: 'PLAN', to_phase: 'OPENCODE_RUNNING', next_action: 'dispatch_opencode_candidate_patch_via_nemoclaw' });
  expect(readStory(rootDir, 'STORY-SCHED')).toMatchObject({ status: 'running', current_phase: 'OPENCODE_RUNNING' });
});
