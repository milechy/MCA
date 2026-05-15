const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CRITICAL_SECTION_PHASES,
  inCriticalSection,
  selectRunnableStories
} = require('../../src/ralph/autonomous-scheduler');
const { createStory, updateStory } = require('../../src/ralph/story-queue');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-serial-'));
}

function seedStory(rootDir, opts = {}) {
  const c = createStory({
    story_id: opts.story_id,
    title: opts.title || opts.story_id,
    requirement: opts.requirement || 'x',
    requested_paths: opts.requested_paths || ['docs/x.md'],
    priority: typeof opts.priority === 'number' ? opts.priority : 50,
    mode: opts.mode || 'approval',
    target_env: 'local'
  }, { rootDir, now: opts.now || new Date() });
  expect(c.ok).toBe(true);
  if (opts.transition_to) {
    updateStory(opts.story_id, { current_phase: opts.transition_to, status: opts.transition_to === 'ESCALATED' ? 'failed' : 'running' }, { rootDir, now: opts.now || new Date(), event: 'seeded_transition' });
  }
  return opts.story_id;
}

test('CRITICAL_SECTION_PHASES covers APPLY/GATES/COMMIT_APPROVAL_PENDING/COMMIT, NOT PATCH_PREVIEW or DIFF_APPROVAL_PENDING', () => {
  expect(CRITICAL_SECTION_PHASES.has('APPLY')).toBe(true);
  expect(CRITICAL_SECTION_PHASES.has('GATES')).toBe(true);
  expect(CRITICAL_SECTION_PHASES.has('COMMIT_APPROVAL_PENDING')).toBe(true);
  expect(CRITICAL_SECTION_PHASES.has('COMMIT')).toBe(true);
  expect(CRITICAL_SECTION_PHASES.has('PATCH_PREVIEW')).toBe(false);
  expect(CRITICAL_SECTION_PHASES.has('DIFF_APPROVAL_PENDING')).toBe(false);
  expect(CRITICAL_SECTION_PHASES.has('OPENCODE_RUNNING')).toBe(false);
  expect(CRITICAL_SECTION_PHASES.has('PUSH_APPROVAL_PENDING')).toBe(false);
});

test('inCriticalSection identifies critical phases correctly', () => {
  expect(inCriticalSection({ current_phase: 'APPLY' })).toBe(true);
  expect(inCriticalSection({ current_phase: 'GATES' })).toBe(true);
  expect(inCriticalSection({ current_phase: 'COMMIT_APPROVAL_PENDING' })).toBe(true);
  expect(inCriticalSection({ current_phase: 'COMMIT' })).toBe(true);
  expect(inCriticalSection({ current_phase: 'OPENCODE_RUNNING' })).toBe(false);
  expect(inCriticalSection({ current_phase: 'PATCH_PREVIEW' })).toBe(false);
  expect(inCriticalSection({ current_phase: 'PUSH_APPROVAL_PENDING' })).toBe(false);
  expect(inCriticalSection(null)).toBe(false);
});

test('selectRunnableStories returns ONLY the critical-section holder when one exists', () => {
  const root = tmpRoot();
  seedStory(root, { story_id: 'STORY-A-CRITICAL', priority: 50, transition_to: 'APPLY' });
  seedStory(root, { story_id: 'STORY-B-PLAIN', priority: 100 });
  seedStory(root, { story_id: 'STORY-C-PLAIN', priority: 90 });

  const selected = selectRunnableStories({ rootDir: root, limit: 25 });
  expect(selected.length).toBe(1);
  expect(selected[0].story_id).toBe('STORY-A-CRITICAL');
});

test('selectRunnableStories returns up to N stories when none are in the critical section', () => {
  const root = tmpRoot();
  seedStory(root, { story_id: 'STORY-A', priority: 100 });
  seedStory(root, { story_id: 'STORY-B', priority: 90 });
  seedStory(root, { story_id: 'STORY-C', priority: 80 });

  const selected = selectRunnableStories({ rootDir: root, limit: 25 });
  expect(selected.length).toBe(3);
});

test('selectRunnableStories picks the highest-priority critical holder when multiple are in the critical section', () => {
  // This should not happen in normal operation, but if it does (e.g. through
  // operator manual edits or a daemon-restart race), the scheduler must pick
  // one deterministically.
  const root = tmpRoot();
  seedStory(root, { story_id: 'STORY-HIGH-COMMIT', priority: 30, transition_to: 'COMMIT' });
  seedStory(root, { story_id: 'STORY-LOW-APPLY', priority: 100, transition_to: 'APPLY' });

  const selected = selectRunnableStories({ rootDir: root, limit: 25 });
  expect(selected.length).toBe(1);
  // Lower priorityScore = higher priority in sortStoriesByPriority; HIGH-COMMIT
  // (priority: 30) ranks ahead of LOW-APPLY (priority: 100).
  expect(selected[0].story_id).toBe('STORY-HIGH-COMMIT');
});

test('selectRunnableStories with one APPLY holder + many PATCH_PREVIEW + DIFF_APPROVAL_PENDING followers picks the APPLY holder', () => {
  const root = tmpRoot();
  seedStory(root, { story_id: 'STORY-IN-APPLY', priority: 50, transition_to: 'APPLY' });
  seedStory(root, { story_id: 'STORY-PATCH-1', priority: 90, transition_to: 'PATCH_PREVIEW' });
  seedStory(root, { story_id: 'STORY-DIFF-PENDING-2', priority: 80, transition_to: 'DIFF_APPROVAL_PENDING' });
  seedStory(root, { story_id: 'STORY-OPENCODE-3', priority: 70, transition_to: 'OPENCODE_RUNNING' });

  const selected = selectRunnableStories({ rootDir: root, limit: 25 });
  expect(selected.length).toBe(1);
  expect(selected[0].story_id).toBe('STORY-IN-APPLY');
});

test('selectRunnableStories releases the lock once the holder transitions past the critical section', () => {
  const root = tmpRoot();
  // Initial holder in COMMIT
  seedStory(root, { story_id: 'STORY-HOLDER', priority: 50, transition_to: 'COMMIT' });
  seedStory(root, { story_id: 'STORY-WAITER-A', priority: 90 });
  seedStory(root, { story_id: 'STORY-WAITER-B', priority: 80 });

  // While holder is in COMMIT, only it is selected.
  expect(selectRunnableStories({ rootDir: root, limit: 25 }).map((s) => s.story_id)).toEqual(['STORY-HOLDER']);

  // Holder transitions past the critical section to PUSH_APPROVAL_PENDING.
  updateStory('STORY-HOLDER', { current_phase: 'PUSH_APPROVAL_PENDING', status: 'waiting_approval' }, { rootDir: root, now: new Date(), event: 'commit_completed' });

  // Now the queue drains: holder still runnable (waiting_approval is runnable),
  // plus both waiters. None are in the critical section, so we return all
  // three up to limit.
  const selected = selectRunnableStories({ rootDir: root, limit: 25 });
  expect(selected.length).toBeGreaterThanOrEqual(2);
  expect(selected.map((s) => s.story_id)).toContain('STORY-WAITER-A');
  expect(selected.map((s) => s.story_id)).toContain('STORY-WAITER-B');
});
