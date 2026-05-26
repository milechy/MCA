const fs = require('node:fs');
const path = require('node:path');
const { loadMode } = require('./mode-manager');

const DEFAULT_MAX_CYCLES_SAME_PHASE = 5;

function defaultListStories(rootDir) {
  const dir = path.join(rootDir, '.ralph', 'stories');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch (_err) { /* skip malformed */ }
  }
  return out;
}

function suggestActionForStuckStory(stuckEntry, modeState) {
  if (
    stuckEntry.current_phase &&
    stuckEntry.current_phase.endsWith('_APPROVAL_PENDING') &&
    modeState &&
    modeState.mode === 'fullauto' &&
    modeState.effective_until &&
    new Date(modeState.effective_until).getTime() < new Date(stuckEntry.updated_at).getTime() + 60000
  ) {
    return 'extend_fullauto_mode';
  }
  if (stuckEntry.current_phase && stuckEntry.current_phase.endsWith('_APPROVAL_PENDING')) {
    return 'review_blocked_approval';
  }
  if (stuckEntry.status === 'running') {
    return 'restart_dispatch';
  }
  return 'human_escalation';
}

function detectStuckStories({
  rootDir,
  now = new Date(),
  maxCyclesSamePhase = DEFAULT_MAX_CYCLES_SAME_PHASE,
  listStories,
  cycleIntervalMs = 60000
} = {}) {
  const checked_at = now.toISOString();

  if (!rootDir) {
    return { ok: false, reason: 'rootdir_required', stuck: [], mode_expired_blocking: false, checked_at };
  }

  const listFn = listStories || defaultListStories;

  let stories;
  try {
    stories = listFn(rootDir);
  } catch (_err) {
    return { ok: false, reason: 'list_stories_failed', stuck: [], mode_expired_blocking: false, checked_at };
  }

  const stuck = [];
  for (const story of stories) {
    const status = story.status;
    const current_phase = story.current_phase;
    const updated_at = story.updated_at;

    if (!updated_at) continue;
    if (!current_phase) continue;

    const terminalPhases = ['DONE', 'ESCALATED', 'STOPPED'];
    if (terminalPhases.includes(current_phase)) continue;

    if (status !== 'running' && status !== 'waiting_approval') continue;

    const updatedAt = new Date(updated_at);
    const cycles_in_phase = Math.floor((now.getTime() - updatedAt.getTime()) / cycleIntervalMs);

    if (cycles_in_phase >= maxCyclesSamePhase) {
      let modeState;
      try {
        modeState = loadMode(rootDir);
      } catch (_err) {
        modeState = null;
      }

      const suggested_action = suggestActionForStuckStory(
        { current_phase, status, updated_at, cycles_in_phase },
        modeState
      );

      stuck.push({
        story_id: story.story_id || story.id,
        current_phase,
        status,
        cycles_in_phase,
        updated_at,
        suggested_action
      });
    }
  }

  stuck.sort((a, b) => b.cycles_in_phase - a.cycles_in_phase);

  let mode_expired_blocking = false;
  try {
    const mode = loadMode(rootDir);
    if (
      mode &&
      mode.mode === 'fullauto' &&
      mode.effective_until &&
      new Date(mode.effective_until).getTime() <= now.getTime()
    ) {
      const hasApprovalPending = stuck.some(s => s.current_phase.endsWith('_APPROVAL_PENDING'));
      if (hasApprovalPending) {
        mode_expired_blocking = true;
      }
    }
  } catch (_err) {
    mode_expired_blocking = false;
  }

  return { ok: true, stuck, mode_expired_blocking, checked_at };
}

module.exports = {
  DEFAULT_MAX_CYCLES_SAME_PHASE,
  detectStuckStories,
  suggestActionForStuckStory,
  defaultListStories
};
