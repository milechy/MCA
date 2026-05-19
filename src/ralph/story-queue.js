const fs = require('node:fs');
const path = require('node:path');

const STORY_QUEUE_VERSION = 'story_queue_v0_1';
const STORY_DIR = path.join('.ralph', 'stories');
const STORY_STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  FAILED: 'failed',
  COMPLETED: 'completed',
  STOPPED: 'stopped'
});

const ALLOWED_STATUSES = new Set(Object.values(STORY_STATUSES));

function oneLine(value, maxLength = 2000) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizePath(value) {
  const item = String(value || '').replace(/\\/g, '/').trim();
  if (!item || item.startsWith('/') || item.includes('..')) return null;
  return item;
}

function normalizeIsoTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeStringList(value, limit = 50, maxLength = 240) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => oneLine(item, maxLength)).filter(Boolean))).slice(0, limit);
}

function normalizeRequestedPaths(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(normalizePath).filter(Boolean))).slice(0, 50);
}

// Phase 3 #1 helpers for optional planner/executor metadata.
function normalizeOptionalString(value, maxLength = 120) {
  if (value === null || value === undefined) return null;
  const s = oneLine(String(value), maxLength);
  return s ? s : null;
}

const ALLOWED_DIFFICULTIES = Object.freeze(['trivial', 'easy', 'medium', 'hard', 'architectural']);
function normalizeDifficulty(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).toLowerCase().trim();
  return ALLOWED_DIFFICULTIES.includes(s) ? s : null;
}

function normalizeLabels(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => {
    if (typeof item === 'string') return oneLine(item, 80);
    if (item && typeof item === 'object') return oneLine(item.name || item.label || '', 80);
    return '';
  }).filter(Boolean))).slice(0, 25);
}

function normalizeGitHubIssue(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    issue_number: value.issue_number || value.number || null,
    title: oneLine(value.title || '', 240),
    url: value.url || value.html_url || null,
    labels: normalizeLabels(value.labels || [])
  };
}

function safeStoryId(storyId) {
  const value = String(storyId || '').trim();
  return /^STORY-[A-Z0-9][A-Z0-9_-]{0,80}$/.test(value) ? value : null;
}

function defaultStoryId(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `STORY-${stamp}`;
}

function storyDirectory(rootDir) {
  return path.join(rootDir, STORY_DIR);
}

function storyPath(rootDir, storyId) {
  const id = safeStoryId(storyId);
  if (!id) return null;
  return path.join(storyDirectory(rootDir), `${id}.json`);
}

function normalizeStatus(status) {
  const value = String(status || STORY_STATUSES.QUEUED).trim();
  return ALLOWED_STATUSES.has(value) ? value : null;
}

function buildStory(input = {}, { now = new Date() } = {}) {
  const id = safeStoryId(input.story_id) || defaultStoryId(now);
  const requirement = oneLine(input.requirement || input.objective || input.prompt || '', 4000);
  if (!requirement) return { ok: false, reason: 'requirement_required' };
  const status = normalizeStatus(input.status || STORY_STATUSES.QUEUED);
  if (!status) return { ok: false, reason: 'story_status_not_allowed' };
  const priority = Number.isFinite(input.priority) ? Math.max(0, Math.min(1000, input.priority)) : null;
  return {
    ok: true,
    story: {
      story_queue_version: STORY_QUEUE_VERSION,
      story_id: id,
      title: oneLine(input.title || requirement, 160),
      requirement,
      acceptance_criteria: normalizeStringList(input.acceptance_criteria, 25, 300),
      labels: normalizeLabels(input.labels),
      priority,
      github_issue: normalizeGitHubIssue(input.github_issue),
      mode: input.mode || 'approval',
      target_env: input.target_env || input.environment || 'local',
      requested_paths: normalizeRequestedPaths(input.requested_paths),
      // Phase 3 #1: optional planner/executor metadata. All fields default
      // to null; legacy stories without these continue to work. The
      // idea-refiner (Phase 3 #2) will populate planner_* fields when
      // creating a story from a vague user idea. The dispatcher (Phase 3 #4)
      // will route to executor_model when present, otherwise fall back to
      // the env-based default.
      executor_model: normalizeOptionalString(input.executor_model, 120),
      planner_model: normalizeOptionalString(input.planner_model, 120),
      planner_cost_usd: Number.isFinite(input.planner_cost_usd) && input.planner_cost_usd >= 0 ? input.planner_cost_usd : null,
      difficulty: normalizeDifficulty(input.difficulty),
      status,
      attempts: Number.isInteger(input.attempts) && input.attempts >= 0 ? input.attempts : 0,
      max_attempts: Number.isInteger(input.max_attempts) && input.max_attempts > 0 ? Math.min(input.max_attempts, 10) : 3,
      current_approval_id: input.current_approval_id || null,
      current_job_id: input.current_job_id || null,
      current_plan_hash: input.current_plan_hash || null,
      current_phase: input.current_phase || 'PLAN',
      blocked_reason: input.blocked_reason || null,
      retry_after_at: normalizeIsoTimestamp(input.retry_after_at),
      created_at: input.created_at || now.toISOString(),
      updated_at: input.updated_at || now.toISOString(),
      audit: Array.isArray(input.audit) ? input.audit.slice(-50) : []
    }
  };
}

function summarizeStory(story) {
  return {
    story_id: story.story_id,
    title: story.title,
    status: story.status,
    mode: story.mode,
    target_env: story.target_env,
    labels: story.labels || [],
    priority: story.priority ?? null,
    attempts: story.attempts,
    max_attempts: story.max_attempts,
    current_phase: story.current_phase,
    current_approval_id: story.current_approval_id || null,
    current_job_id: story.current_job_id || null,
    current_plan_hash: story.current_plan_hash || null,
    requested_paths: story.requested_paths || [],
    // Phase 3 #1: surface planner/executor metadata in the bounded summary.
    executor_model: story.executor_model || null,
    planner_model: story.planner_model || null,
    planner_cost_usd: typeof story.planner_cost_usd === 'number' ? story.planner_cost_usd : null,
    difficulty: story.difficulty || null,
    retry_after_at: story.retry_after_at || null,
    updated_at: story.updated_at,
    next_action: story.status === STORY_STATUSES.QUEUED ? 'run_ultraplan_for_story' : 'inspect_story_or_advance_loop'
  };
}

function writeStory(rootDir, story) {
  const id = safeStoryId(story.story_id);
  if (!id) return { ok: false, stage: 'story_queue_write', reason: 'story_id_not_allowed' };
  const status = normalizeStatus(story.status);
  if (!status) return { ok: false, stage: 'story_queue_write', reason: 'story_status_not_allowed' };
  fs.mkdirSync(storyDirectory(rootDir), { recursive: true });
  const record = { ...story, story_queue_version: STORY_QUEUE_VERSION, status, retry_after_at: normalizeIsoTimestamp(story.retry_after_at), updated_at: story.updated_at || new Date().toISOString() };
  fs.writeFileSync(storyPath(rootDir, id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { ok: true, stage: 'story_queue_write', reason: null, story: record, summary: summarizeStory(record) };
}

function createStory(input = {}, { rootDir = process.cwd(), now = new Date() } = {}) {
  const built = buildStory(input, { now });
  if (!built.ok) return { ok: false, stage: 'story_queue_create', reason: built.reason, execution_connected: false, commands_executed: [], files_modified: [], repository_files_modified: [] };
  const story = {
    ...built.story,
    audit: [{ event: 'story_created', at: now.toISOString(), status: built.story.status }]
  };
  const written = writeStory(rootDir, story);
  return {
    ok: written.ok,
    stage: 'story_queue_create',
    reason: written.reason,
    story: written.story,
    summary: written.summary,
    execution_connected: false,
    commands_executed: [],
    files_modified: [path.relative(rootDir, storyPath(rootDir, story.story_id)).replace(/\\/g, '/')],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: 'run_ultraplan_for_story'
  };
}

function readStory(rootDir, storyId) {
  const filePath = storyPath(rootDir, storyId);
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listStories({ rootDir = process.cwd(), status = null, limit = 20 } = {}) {
  const dir = storyDirectory(rootDir);
  if (!fs.existsSync(dir)) return [];
  const normalizedStatus = status ? normalizeStatus(status) : null;
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')))
    .filter((story) => !normalizedStatus || story.status === normalizedStatus)
    .slice(0, Math.max(1, Math.min(100, limit)));
}

function findStoryByApprovalId(rootDir, approvalId) {
  if (!approvalId) return null;
  return listStories({ rootDir, limit: 100 }).find((story) => story.current_approval_id === approvalId) || null;
}

function updateStory(storyId, patch = {}, { rootDir = process.cwd(), now = new Date(), event = 'story_updated' } = {}) {
  const current = readStory(rootDir, storyId);
  if (!current) return { ok: false, stage: 'story_queue_update', reason: 'story_not_found', story_id: safeStoryId(storyId) };
  const status = patch.status === undefined ? current.status : normalizeStatus(patch.status);
  if (!status) return { ok: false, stage: 'story_queue_update', reason: 'story_status_not_allowed', story_id: current.story_id };
  const updated = {
    ...current,
    ...patch,
    story_id: current.story_id,
    status,
    labels: patch.labels ? normalizeLabels(patch.labels) : current.labels,
    github_issue: patch.github_issue ? normalizeGitHubIssue(patch.github_issue) : current.github_issue,
    requested_paths: patch.requested_paths ? normalizeRequestedPaths(patch.requested_paths) : current.requested_paths,
    // Phase 3 #1: optional fields with normalization. Setting to null
    // explicitly clears them; omitting from the patch preserves current.
    executor_model: Object.prototype.hasOwnProperty.call(patch, 'executor_model') ? normalizeOptionalString(patch.executor_model, 120) : current.executor_model || null,
    planner_model: Object.prototype.hasOwnProperty.call(patch, 'planner_model') ? normalizeOptionalString(patch.planner_model, 120) : current.planner_model || null,
    planner_cost_usd: Object.prototype.hasOwnProperty.call(patch, 'planner_cost_usd')
      ? (Number.isFinite(patch.planner_cost_usd) && patch.planner_cost_usd >= 0 ? patch.planner_cost_usd : null)
      : (typeof current.planner_cost_usd === 'number' ? current.planner_cost_usd : null),
    difficulty: Object.prototype.hasOwnProperty.call(patch, 'difficulty') ? normalizeDifficulty(patch.difficulty) : current.difficulty || null,
    acceptance_criteria: patch.acceptance_criteria ? normalizeStringList(patch.acceptance_criteria, 25, 300) : current.acceptance_criteria,
    retry_after_at: Object.prototype.hasOwnProperty.call(patch, 'retry_after_at') ? normalizeIsoTimestamp(patch.retry_after_at) : current.retry_after_at || null,
    updated_at: now.toISOString(),
    audit: [...(current.audit || []), { event, at: now.toISOString(), status }].slice(-50)
  };
  return writeStory(rootDir, updated);
}

function markStoryForReplanByApproval(approvalId, instruction, { rootDir = process.cwd(), now = new Date() } = {}) {
  const story = findStoryByApprovalId(rootDir, approvalId);
  if (!story) return { ok: false, stage: 'story_queue_replan', reason: 'story_not_found_for_approval', approval_id: approvalId };
  const updated = updateStory(story.story_id, {
    status: STORY_STATUSES.QUEUED,
    current_phase: 'PLAN',
    current_approval_id: null,
    current_job_id: null,
    current_plan_hash: null,
    current_candidate_patch_path: null,
    blocked_reason: 'modify_requires_replan',
    retry_after_at: null,
    modify_instruction: oneLine(instruction, 1000),
    requirement: instruction ? `${story.requirement} Modify: ${oneLine(instruction, 1000)}` : story.requirement
  }, { rootDir, now, event: 'story_replan_requested' });
  return { ...updated, stage: 'story_queue_replan', approval_id: approvalId };
}

module.exports = {
  STORY_QUEUE_VERSION,
  STORY_DIR,
  STORY_STATUSES,
  safeStoryId,
  defaultStoryId,
  buildStory,
  createStory,
  writeStory,
  readStory,
  listStories,
  findStoryByApprovalId,
  updateStory,
  markStoryForReplanByApproval,
  summarizeStory,
  normalizeLabels,
  normalizeRequestedPaths,
  normalizeIsoTimestamp,
  normalizeOptionalString,
  normalizeDifficulty,
  ALLOWED_DIFFICULTIES
};
