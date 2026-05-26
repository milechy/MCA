const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_MAX_CYCLES_SAME_PHASE,
  detectStuckStories,
  suggestActionForStuckStory,
  defaultListStories
} = require('../../src/ralph/stuck-watchdog');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-watchdog-'));
}

function writeMode(rootDir, modeJson) {
  // loadMode() reads <rootDir>/.ralph/mode.json. We inject by writing it.
  const dir = path.join(rootDir, '.ralph');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mode.json'), JSON.stringify(modeJson, null, 2));
}

function cyclesAgoIso(now, cycles, intervalMs = 60000) {
  return new Date(now.getTime() - cycles * intervalMs).toISOString();
}

// ============================================================
// DEFAULT_MAX_CYCLES_SAME_PHASE constant
// ============================================================

test('Phase 5 #5: DEFAULT_MAX_CYCLES_SAME_PHASE is 5', () => {
  expect(DEFAULT_MAX_CYCLES_SAME_PHASE).toBe(5);
});

// ============================================================
// detectStuckStories
// ============================================================

test('Phase 5 #5: detectStuckStories returns empty list when no stories are present', () => {
  const rootDir = tmpRoot();
  fs.mkdirSync(path.join(rootDir, '.ralph', 'stories'), { recursive: true });
  const result = detectStuckStories({ rootDir, now: new Date('2026-05-26T00:00:00Z') });
  expect(result.ok).toBe(true);
  expect(result.stuck).toEqual([]);
  expect(result.mode_expired_blocking).toBe(false);
  expect(typeof result.checked_at).toBe('string');
});

test('Phase 5 #5: detectStuckStories does NOT flag DONE / ESCALATED / STOPPED stories', () => {
  const rootDir = tmpRoot();
  const now = new Date('2026-05-26T01:00:00Z');
  const oneHourAgo = cyclesAgoIso(now, 60); // 60 cycles, well past threshold
  const listStories = () => [
    { story_id: 'S-DONE', status: 'completed', current_phase: 'DONE', updated_at: oneHourAgo },
    { story_id: 'S-ESC', status: 'failed', current_phase: 'ESCALATED', updated_at: oneHourAgo },
    { story_id: 'S-STOP', status: 'stopped', current_phase: 'STOPPED', updated_at: oneHourAgo }
  ];
  const result = detectStuckStories({ rootDir, now, listStories });
  expect(result.ok).toBe(true);
  expect(result.stuck).toEqual([]);
});

test('Phase 5 #5: detectStuckStories flags a running story past the cycle threshold', () => {
  const rootDir = tmpRoot();
  const now = new Date('2026-05-26T01:00:00Z');
  // 6 cycles ago (>= 5 threshold) — should be flagged
  const sixCyclesAgo = cyclesAgoIso(now, 6);
  const listStories = () => [
    { story_id: 'S1', status: 'running', current_phase: 'OPENCODE_RUNNING', updated_at: sixCyclesAgo }
  ];
  const result = detectStuckStories({ rootDir, now, listStories });
  expect(result.ok).toBe(true);
  expect(result.stuck).toHaveLength(1);
  expect(result.stuck[0].story_id).toBe('S1');
  expect(result.stuck[0].cycles_in_phase).toBeGreaterThanOrEqual(5);
  expect(result.stuck[0].suggested_action).toBe('restart_dispatch');
});

test('Phase 5 #5: detectStuckStories flags a waiting_approval story and tags it review_blocked_approval (mode=approval)', () => {
  const rootDir = tmpRoot();
  const now = new Date('2026-05-26T01:00:00Z');
  const sixCyclesAgo = cyclesAgoIso(now, 6);
  writeMode(rootDir, { mode: 'approval' });
  const listStories = () => [
    { story_id: 'S2', status: 'waiting_approval', current_phase: 'DIFF_APPROVAL_PENDING', updated_at: sixCyclesAgo }
  ];
  const result = detectStuckStories({ rootDir, now, listStories });
  expect(result.ok).toBe(true);
  expect(result.stuck).toHaveLength(1);
  expect(result.stuck[0].suggested_action).toBe('review_blocked_approval');
});

test('Phase 5 #5: detectStuckStories surfaces mode_expired_blocking when fullauto expired AND an approval-pending story is stuck', () => {
  const rootDir = tmpRoot();
  const now = new Date('2026-05-26T01:00:00Z');
  const sixCyclesAgo = cyclesAgoIso(now, 6);
  // fullauto expired BEFORE the story was last updated (i.e. effective_until < story.updated_at)
  // and ALSO <= now (so the mode_expired_blocking branch fires).
  writeMode(rootDir, {
    mode: 'fullauto',
    effective_until: new Date(now.getTime() - 7 * 60000).toISOString() // 7 cycles ago, before the 6-cycle-old story
  });
  const listStories = () => [
    { story_id: 'S3', status: 'waiting_approval', current_phase: 'PUSH_APPROVAL_PENDING', updated_at: sixCyclesAgo }
  ];
  const result = detectStuckStories({ rootDir, now, listStories });
  expect(result.ok).toBe(true);
  expect(result.mode_expired_blocking).toBe(true);
  expect(result.stuck[0].suggested_action).toBe('extend_fullauto_mode');
});

test('Phase 5 #5: detectStuckStories sorts stuck entries by cycles_in_phase descending', () => {
  const rootDir = tmpRoot();
  const now = new Date('2026-05-26T01:00:00Z');
  const listStories = () => [
    { story_id: 'S-NEWER', status: 'running', current_phase: 'OPENCODE_RUNNING', updated_at: cyclesAgoIso(now, 6) },
    { story_id: 'S-OLDER', status: 'running', current_phase: 'OPENCODE_RUNNING', updated_at: cyclesAgoIso(now, 10) }
  ];
  const result = detectStuckStories({ rootDir, now, listStories });
  expect(result.stuck).toHaveLength(2);
  expect(result.stuck[0].story_id).toBe('S-OLDER');
  expect(result.stuck[0].cycles_in_phase).toBeGreaterThan(result.stuck[1].cycles_in_phase);
  expect(result.stuck[1].story_id).toBe('S-NEWER');
});

test('Phase 5 #5: detectStuckStories returns ok:false when listStories throws', () => {
  const rootDir = tmpRoot();
  const result = detectStuckStories({
    rootDir,
    now: new Date(),
    listStories: () => { throw new Error('disk gone'); }
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('list_stories_failed');
  expect(result.stuck).toEqual([]);
  expect(result.mode_expired_blocking).toBe(false);
});

test('Phase 5 #5: detectStuckStories returns ok:false when rootDir is missing', () => {
  const result = detectStuckStories({ now: new Date() });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('rootdir_required');
  expect(result.stuck).toEqual([]);
});

test('Phase 5 #5: detectStuckStories does NOT flag stories younger than the cycle threshold', () => {
  const rootDir = tmpRoot();
  const now = new Date('2026-05-26T01:00:00Z');
  // 4 cycles old — under the default threshold of 5
  const listStories = () => [
    { story_id: 'S-FRESH', status: 'running', current_phase: 'OPENCODE_RUNNING', updated_at: cyclesAgoIso(now, 4) }
  ];
  const result = detectStuckStories({ rootDir, now, listStories });
  expect(result.stuck).toEqual([]);
});

// ============================================================
// suggestActionForStuckStory unit cases
// ============================================================

test('Phase 5 #5: suggestActionForStuckStory unit cases', () => {
  const updatedAt = '2026-05-26T00:00:00Z';
  // approval_pending + fullauto mode expired BEFORE the story was last updated → extend_fullauto_mode
  const earlyExpire = '2026-05-25T23:50:00Z'; // 10min before updated_at
  expect(suggestActionForStuckStory(
    { current_phase: 'PUSH_APPROVAL_PENDING', status: 'waiting_approval', updated_at: updatedAt },
    { mode: 'fullauto', effective_until: earlyExpire }
  )).toBe('extend_fullauto_mode');

  // approval_pending + mode=approval (or no mode) → review_blocked_approval
  expect(suggestActionForStuckStory(
    { current_phase: 'DIFF_APPROVAL_PENDING', status: 'waiting_approval', updated_at: updatedAt },
    { mode: 'approval' }
  )).toBe('review_blocked_approval');
  expect(suggestActionForStuckStory(
    { current_phase: 'COMMIT_APPROVAL_PENDING', status: 'waiting_approval', updated_at: updatedAt },
    null
  )).toBe('review_blocked_approval');

  // running phase → restart_dispatch
  expect(suggestActionForStuckStory(
    { current_phase: 'OPENCODE_RUNNING', status: 'running', updated_at: updatedAt },
    null
  )).toBe('restart_dispatch');

  // failed / unknown shape → human_escalation
  expect(suggestActionForStuckStory(
    { current_phase: 'GATES', status: 'failed', updated_at: updatedAt },
    null
  )).toBe('human_escalation');
});

// ============================================================
// defaultListStories
// ============================================================

test('Phase 5 #5: defaultListStories reads .ralph/stories/*.json and skips malformed files', () => {
  const rootDir = tmpRoot();
  const storiesDir = path.join(rootDir, '.ralph', 'stories');
  fs.mkdirSync(storiesDir, { recursive: true });
  fs.writeFileSync(path.join(storiesDir, 's1.json'), JSON.stringify({ story_id: 's1', status: 'running' }));
  fs.writeFileSync(path.join(storiesDir, 's2.json'), JSON.stringify({ story_id: 's2', status: 'waiting_approval' }));
  fs.writeFileSync(path.join(storiesDir, 'broken.json'), 'not json at all');
  // Non-json files are ignored.
  fs.writeFileSync(path.join(storiesDir, 'readme.txt'), 'some doc');

  const result = defaultListStories(rootDir);
  expect(result).toHaveLength(2);
  const ids = result.map((s) => s.story_id).sort();
  expect(ids).toEqual(['s1', 's2']);
});

test('Phase 5 #5: defaultListStories returns [] when .ralph/stories does not exist', () => {
  const rootDir = tmpRoot();
  // No .ralph/stories at all
  expect(defaultListStories(rootDir)).toEqual([]);
});
