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

function normalizeStringList(value, limit = 50, maxLength = 240) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => oneLine(item, maxLength)).filter(Boolean))).slice(0, limit);
}

function normalizeRequestedPaths(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(normalizePath).filter(Boolean))).slice(0, 50);
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
  return {
    ok: true,
    story: {
      story_queue_version: STORY_QUEUE_VERSION,
      story_id: id,
      title: oneLine(input.title || requirement, 160),
      requirement,
      acceptance_criteria: normalizeStringList(input.acceptance_criteria, 25, 300),
      mode: input.mode || 'approval',
      target_env: input.target_env || input.environment || 'local',
      requested_paths: normalizeRequestedPaths(input.requested_paths),
      status,
      attempts: Number.isInteger(input.attempts) && input.attempts >= 0 ? input.attempts : 0,
      max_attempts: Number.isInteger(input.max_attempts) && input.max_attempts > 0 ? Math.min(input.max_attempts, 10) : 3,
      current_approval_id: input.current_approval_id || null,
      current_job_id: input.current_job_id || null,
      current_plan_hash: input.current_plan_hash || null,
      current_phase: input.current_phase || 'PLAN',
      blocked_reason: input.blocked_reason || null,
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
    attempts: story.attempts,
    max_attempts: story.max_attempts,
    current_phase: story.current_phase,
    current_approval_id: story.current_approval_id || null,
    current_job_id: story.current_job_id || null,
    current_plan_hash: story.current_plan_hash || null,
    requested_paths: story.requested_paths || [],
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
  const record = { ...story, story_queue_version: STORY_QUEUE_VERSION, status, updated_at: story.updated_at || new Date().toISOString() };
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
    requested_paths: patch.requested_paths ? normalizeRequestedPaths(patch.requested_paths) : current.requested_paths,
    acceptance_criteria: patch.acceptance_criteria ? normalizeStringList(patch.acceptance_criteria, 25, 300) : current.acceptance_criteria,
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
  normalizeRequestedPaths
};
