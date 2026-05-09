const { createStory, readStory, listStories, summarizeStory } = require('../ralph/story-queue');
const { tickAutonomousLoop, pauseStory } = require('../ralph/autonomous-loop');
const { readBoundedArtifact } = require('./opencode-artifacts');

function jsonBlock(value) {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function textResponse(text, extra = {}) {
  return { ok: true, text, wired_to_runtime: false, execution_connected: false, ...extra };
}

function isAutonomousCommand(type) {
  return ['ralph_start', 'ralph_loop_status', 'ralph_pause', 'ralph_resume', 'ralph_stop', 'ralph_artifact'].includes(type);
}

function ralphStart(parsed, context) {
  const requirement = parsed.args.join(' ').trim();
  if (!requirement) {
    const result = { ok: false, stage: 'ralph_start', reason: 'requirement_required', execution_connected: false, commands_executed: [] };
    return textResponse(`Ralph start failed: requirement_required${jsonBlock(result)}`, { result, summary: result });
  }
  const created = createStory({
    requirement,
    mode: context.mode || 'approval',
    target_env: context.target_env || 'local',
    requested_paths: context.requested_paths || []
  }, { rootDir: context.rootDir, now: context.now || new Date() });
  const tick = created.ok ? tickAutonomousLoop({ rootDir: context.rootDir, story_id: created.story.story_id, now: context.now || new Date() }) : null;
  const result = {
    ok: created.ok && (!tick || tick.ok === true),
    stage: 'ralph_start',
    reason: created.reason || tick?.reason || null,
    story: created.summary || null,
    tick,
    execution_connected: false,
    commands_executed: [],
    files_modified: created.files_modified || [],
    repository_files_modified: [],
    next_action: tick?.next_action || created.next_action || null
  };
  return textResponse(`Ralph autonomous story started.${jsonBlock(result)}`, { result, summary: result });
}

function ralphLoopStatus(parsed, context) {
  const [storyId] = parsed.args;
  if (storyId) {
    const story = readStory(context.rootDir, storyId);
    if (!story) {
      const result = { ok: false, stage: 'ralph_loop_status', reason: 'story_not_found', story_id: storyId, execution_connected: false, commands_executed: [] };
      return textResponse(`Ralph loop status failed: story_not_found${jsonBlock(result)}`, { result, summary: result });
    }
    const result = { ok: true, stage: 'ralph_loop_status', reason: null, story: summarizeStory(story), execution_connected: false, commands_executed: [], files_modified: [], repository_files_modified: [] };
    return textResponse(`Ralph loop status.${jsonBlock(result)}`, { result, summary: result });
  }
  const stories = listStories({ rootDir: context.rootDir, limit: 10 }).map(summarizeStory);
  const result = { ok: true, stage: 'ralph_loop_status', reason: null, stories, execution_connected: false, commands_executed: [], files_modified: [], repository_files_modified: [] };
  return textResponse(`Ralph loop status.${jsonBlock(result)}`, { result, summary: result });
}

function ralphPauseOrStop(parsed, context) {
  const [storyId] = parsed.args;
  if (!storyId) {
    const result = { ok: false, stage: parsed.type, reason: 'story_id_required', execution_connected: false, commands_executed: [] };
    return textResponse(`Ralph ${parsed.type === 'ralph_pause' ? 'pause' : 'stop'} failed: story_id_required${jsonBlock(result)}`, { result, summary: result });
  }
  const result = pauseStory(storyId, { rootDir: context.rootDir, now: context.now || new Date(), reason: parsed.type });
  return textResponse(`Ralph story stopped.${jsonBlock(result)}`, { result, summary: result });
}

function ralphResume(parsed, context) {
  const [storyId, approvalId] = parsed.args;
  if (!storyId) {
    const result = { ok: false, stage: 'ralph_resume', reason: 'story_id_required', execution_connected: false, commands_executed: [] };
    return textResponse(`Ralph resume failed: story_id_required${jsonBlock(result)}`, { result, summary: result });
  }
  const approvals = approvalId ? { [approvalId]: 'approved' } : {};
  const result = tickAutonomousLoop({ rootDir: context.rootDir, story_id: storyId, now: context.now || new Date(), approvals });
  return textResponse(`Ralph loop resumed/ticked.${jsonBlock(result)}`, { result, summary: result });
}

function ralphArtifact(parsed, context) {
  const [jobId, artifactType, artifactPath] = parsed.args;
  const result = readBoundedArtifact({ rootDir: context.rootDir, job_id: jobId, artifact_type: artifactType || 'candidate_patch', artifact_path: artifactPath });
  return textResponse(result.ok ? `Ralph artifact retrieved.${jsonBlock(result)}` : `Ralph artifact retrieval failed: ${result.reason}${jsonBlock(result)}`, { result, summary: result });
}

function handleAutonomousCommand(parsed, context = {}) {
  const rootDir = context.rootDir || process.cwd();
  const commandContext = { ...context, rootDir };
  if (parsed.type === 'ralph_start') return ralphStart(parsed, commandContext);
  if (parsed.type === 'ralph_loop_status') return ralphLoopStatus(parsed, commandContext);
  if (parsed.type === 'ralph_pause' || parsed.type === 'ralph_stop') return ralphPauseOrStop(parsed, commandContext);
  if (parsed.type === 'ralph_resume') return ralphResume(parsed, commandContext);
  if (parsed.type === 'ralph_artifact') return ralphArtifact(parsed, commandContext);
  return textResponse('Unknown autonomous command.', { parsed });
}

module.exports = {
  isAutonomousCommand,
  handleAutonomousCommand,
  jsonBlock
};
