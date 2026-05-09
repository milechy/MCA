const { createStory, readStory, listStories, summarizeStory } = require('../ralph/story-queue');
const { tickAutonomousLoop, pauseStory } = require('../ralph/autonomous-loop');
const { readBoundedArtifact } = require('./opencode-artifacts');

const BLOCKING_NEXT_ACTIONS = new Set([
  'request_plan_approval_then_resume',
  'request_diff_approval_then_resume',
  'request_commit_approval_then_resume',
  'request_push_approval_then_resume',
  'request_pr_approval_then_resume',
  'approve_or_modify_story_before_resume',
  'human_escalation_required',
  'story_complete',
  'story_stopped',
  'fix_opencode_dispatch_failure',
  'inspect_autonomous_loop_failure',
  'implement_next_autonomous_loop_phase'
]);

function jsonBlock(value) {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function textResponse(text, extra = {}) {
  return { ok: true, text, wired_to_runtime: false, execution_connected: false, ...extra };
}

function isAutonomousCommand(type) {
  return ['ralph_start', 'ralph_tick', 'ralph_run_until_blocked', 'ralph_loop_status', 'ralph_pause', 'ralph_resume', 'ralph_stop', 'ralph_artifact'].includes(type);
}

function tickOptions(context) {
  return {
    rootDir: context.rootDir,
    now: context.now || new Date(),
    env: context.env || process.env,
    pre_secret_scan_ok: context.pre_secret_scan_ok === true,
    opencode_dispatcher: context.opencode_dispatcher,
    gate_runner: context.gate_runner,
    apply_result: context.apply_result,
    timeout_ms: context.timeout_ms
  };
}

function publicTick(tick) {
  return {
    ok: tick.ok,
    reason: tick.reason || null,
    story_id: tick.story_id,
    from_phase: tick.from_phase,
    to_phase: tick.to_phase,
    approval_id: tick.approval_id || null,
    job_id: tick.job_id || null,
    candidate_patch_path: tick.candidate_patch_path || null,
    execution_connected: tick.execution_connected === true,
    commands_executed: tick.commands_executed || [],
    repository_files_modified: tick.repository_files_modified || [],
    next_action: tick.next_action
  };
}

function runUntilBlocked(storyId, context, { maxTicks = 8 } = {}) {
  const ticks = [];
  let current = null;
  for (let index = 0; index < maxTicks; index += 1) {
    current = tickAutonomousLoop({ ...tickOptions(context), story_id: storyId });
    ticks.push(publicTick(current));
    if (!current.ok || current.to_phase === current.from_phase || BLOCKING_NEXT_ACTIONS.has(current.next_action)) break;
  }
  return {
    ok: ticks.every((tick) => tick.ok === true),
    stage: 'ralph_run_until_blocked',
    story_id: storyId,
    ticks,
    tick_count: ticks.length,
    stopped_at: current?.to_phase || null,
    reason: current?.reason || null,
    execution_connected: ticks.some((tick) => tick.execution_connected === true),
    commands_executed: ticks.flatMap((tick) => tick.commands_executed || []).slice(0, 20),
    repository_files_modified: ticks.flatMap((tick) => tick.repository_files_modified || []).slice(0, 50),
    next_action: current?.next_action || 'inspect_story'
  };
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
  const tick = created.ok ? tickAutonomousLoop({ ...tickOptions(context), story_id: created.story.story_id }) : null;
  const result = {
    ok: created.ok && (!tick || tick.ok === true),
    stage: 'ralph_start',
    reason: created.reason || tick?.reason || null,
    story: created.summary || null,
    tick,
    execution_connected: tick?.execution_connected === true,
    commands_executed: tick?.commands_executed || [],
    files_modified: created.files_modified || [],
    repository_files_modified: tick?.repository_files_modified || [],
    next_action: tick?.next_action || created.next_action || null
  };
  return textResponse(`Ralph autonomous story started.${jsonBlock(result)}`, { result, summary: result });
}

function ralphTick(parsed, context) {
  const [storyId] = parsed.args;
  if (!storyId) {
    const result = { ok: false, stage: 'ralph_tick', reason: 'story_id_required', execution_connected: false, commands_executed: [] };
    return textResponse(`Ralph tick failed: story_id_required${jsonBlock(result)}`, { result, summary: result });
  }
  const result = tickAutonomousLoop({ ...tickOptions(context), story_id: storyId });
  return textResponse(`Ralph loop ticked.${jsonBlock(result)}`, { result, summary: result });
}

function ralphRunUntilBlocked(parsed, context) {
  const [storyId, maybeMaxTicks] = parsed.args;
  if (!storyId) {
    const result = { ok: false, stage: 'ralph_run_until_blocked', reason: 'story_id_required', execution_connected: false, commands_executed: [] };
    return textResponse(`Ralph run-until-blocked failed: story_id_required${jsonBlock(result)}`, { result, summary: result });
  }
  const requestedMaxTicks = Number.parseInt(maybeMaxTicks || '', 10);
  const maxTicks = Number.isInteger(requestedMaxTicks) && requestedMaxTicks > 0 ? Math.min(requestedMaxTicks, 12) : 8;
  const result = runUntilBlocked(storyId, context, { maxTicks });
  return textResponse(`Ralph loop ran until blocked.${jsonBlock(result)}`, { result, summary: result });
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
  const result = tickAutonomousLoop({ ...tickOptions(context), story_id: storyId, approvals });
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
  if (parsed.type === 'ralph_tick') return ralphTick(parsed, commandContext);
  if (parsed.type === 'ralph_run_until_blocked') return ralphRunUntilBlocked(parsed, commandContext);
  if (parsed.type === 'ralph_loop_status') return ralphLoopStatus(parsed, commandContext);
  if (parsed.type === 'ralph_pause' || parsed.type === 'ralph_stop') return ralphPauseOrStop(parsed, commandContext);
  if (parsed.type === 'ralph_resume') return ralphResume(parsed, commandContext);
  if (parsed.type === 'ralph_artifact') return ralphArtifact(parsed, commandContext);
  return textResponse('Unknown autonomous command.', { parsed });
}

module.exports = {
  isAutonomousCommand,
  handleAutonomousCommand,
  runUntilBlocked,
  jsonBlock
};
