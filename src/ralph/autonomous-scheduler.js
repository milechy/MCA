const { listStories, summarizeStory } = require('./story-queue');
const { tickAutonomousLoopWired } = require('./autonomous-loop-wired');
const { sortStoriesByPriority } = require('./story-priority');
const { findApprovedResumeApproval } = require('./resume-after-security-stop');

const SCHEDULER_VERSION = 'autonomous_scheduler_v0_1';
const RUNNABLE_STATUSES = new Set(['queued', 'running', 'waiting_approval']);

// Phase 1 #8 fix: stories in any of these phases hold an exclusive lock on the
// real repository working tree (APPLY writes files into it; GATES reads it for
// secret-scan/playwright; COMMIT_APPROVAL_PENDING parks the commit approval
// against an applied-but-not-committed tree; COMMIT executes git commit
// against that same tree). Allowing two stories to be in this set
// simultaneously caused the 2026-05-14 Phase 1 #7 cascade: story A's APPLY
// landed alongside story B's APPLY, then story A's COMMIT failed because the
// working tree carried files that did not belong to A's commit. The scheduler
// therefore serializes the critical section: when any story occupies it, the
// scheduler returns ONLY that story until it exits to PUSH_APPROVAL_PENDING /
// ESCALATED / FIX_LOOP.
const CRITICAL_SECTION_PHASES = new Set([
  'APPLY',
  'GATES',
  'COMMIT_APPROVAL_PENDING',
  'COMMIT'
]);

function inCriticalSection(story) {
  return !!(story && CRITICAL_SECTION_PHASES.has(story.current_phase));
}

function retryAfterAt(story) {
  if (!story || !story.retry_after_at) return null;
  const timestamp = Date.parse(story.retry_after_at);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function storyBackoffActive(story, now = new Date()) {
  const retryAt = retryAfterAt(story);
  return retryAt !== null && retryAt > now.getTime();
}

function isRunnableStory(story, { now = new Date() } = {}) {
  if (!story || !RUNNABLE_STATUSES.has(story.status)) return false;
  if (story.current_phase === 'STOPPED' || story.current_phase === 'ESCALATED' || story.current_phase === 'DONE') return false;
  if (storyBackoffActive(story, now)) return false;
  return true;
}

function hasApprovedResumeWaiting(story, { rootDir, now = new Date() } = {}) {
  if (!story || !rootDir) return false;
  const stopped = story.current_phase === 'STOPPED_SECURITY'
    || story.current_phase === 'STOPPED'
    || story.status === 'failed'
    || story.status === 'stopped';
  if (!stopped) return false;
  try {
    return findApprovedResumeApproval(rootDir, story.story_id, { now }) !== null;
  } catch {
    return false;
  }
}

function selectRunnableStories({ rootDir = process.cwd(), limit = 5, now = new Date() } = {}) {
  const all = listStories({ rootDir, limit: 100 });
  // Include normally-runnable stories AND stopped stories that have an admin-
  // approved RESUME_AFTER_SECURITY_STOP record waiting to be consumed. The
  // wired loop will detect the approved resume and transition the story back
  // to PLAN_APPROVAL_PENDING on the same tick; without this widening the
  // scheduler would never even call the wired loop for a stopped story.
  const stories = all.filter((story) => isRunnableStory(story, { now }) || hasApprovedResumeWaiting(story, { rootDir, now }));

  // Phase 1 #8 critical-section serialization: if any runnable story is
  // already in {APPLY, GATES, COMMIT_APPROVAL_PENDING, COMMIT}, return only
  // that story. The remaining queue waits in earlier phases (typically
  // DIFF_APPROVAL_PENDING or auto-approved-then-waiting) until the critical-
  // section holder advances to PUSH_APPROVAL_PENDING / ESCALATED / FIX_LOOP.
  // We pick the highest-priority critical holder so a deterministic single
  // story advances per cycle. Cap is hard at 1.
  const criticalHolders = stories.filter(inCriticalSection);
  if (criticalHolders.length > 0) {
    return sortStoriesByPriority(criticalHolders).slice(0, 1);
  }

  return sortStoriesByPriority(stories).slice(0, Math.max(1, Math.min(25, limit)));
}

function schedulerTick({ rootDir = process.cwd(), now = new Date(), limit = 1, ticks_per_story = 1, ...tickOptions } = {}) {
  const selected = selectRunnableStories({ rootDir, limit, now });
  const results = [];
  for (const story of selected) {
    let current = null;
    const storyTicks = [];
    for (let index = 0; index < Math.max(1, Math.min(12, ticks_per_story)); index += 1) {
      current = tickAutonomousLoopWired({ rootDir, story_id: story.story_id, now, ...tickOptions });
      storyTicks.push({
        ok: current.ok,
        reason: current.reason || null,
        story_id: current.story_id,
        from_phase: current.from_phase,
        to_phase: current.to_phase,
        next_action: current.next_action,
        execution_connected: current.execution_connected === true,
        commands_executed: current.commands_executed || []
      });
      if (!current.ok || current.to_phase === current.from_phase || String(current.next_action || '').includes('approval') || current.next_action === 'human_escalation_required') break;
    }
    results.push({ story: summarizeStory(story), ticks: storyTicks, final_next_action: current?.next_action || null });
  }
  return {
    ok: results.every((result) => result.ticks.every((tick) => tick.ok === true)),
    stage: 'autonomous_scheduler_tick',
    version: SCHEDULER_VERSION,
    selected_count: selected.length,
    results,
    execution_connected: results.some((result) => result.ticks.some((tick) => tick.execution_connected)),
    commands_executed: results.flatMap((result) => result.ticks.flatMap((tick) => tick.commands_executed || [])).slice(0, 50),
    repository_files_modified: [],
    next_action: selected.length > 0 ? 'continue_scheduler_or_review_blocked_stories' : 'wait_for_runnable_story'
  };
}

module.exports = {
  SCHEDULER_VERSION,
  CRITICAL_SECTION_PHASES,
  inCriticalSection,
  retryAfterAt,
  storyBackoffActive,
  isRunnableStory,
  selectRunnableStories,
  schedulerTick
};
