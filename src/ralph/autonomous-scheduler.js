const { listStories, summarizeStory } = require('./story-queue');
const { tickAutonomousLoopWired } = require('./autonomous-loop-wired');
const { sortStoriesByPriority } = require('./story-priority');

const SCHEDULER_VERSION = 'autonomous_scheduler_v0_1';
const RUNNABLE_STATUSES = new Set(['queued', 'running', 'waiting_approval']);

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

function selectRunnableStories({ rootDir = process.cwd(), limit = 5, now = new Date() } = {}) {
  const stories = listStories({ rootDir, limit: 100 }).filter((story) => isRunnableStory(story, { now }));
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
  retryAfterAt,
  storyBackoffActive,
  isRunnableStory,
  selectRunnableStories,
  schedulerTick
};
