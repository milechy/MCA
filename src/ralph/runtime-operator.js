const fs = require('node:fs');
const path = require('node:path');
const { readStory, updateStory, summarizeStory, STORY_STATUSES, safeStoryId } = require('./story-queue');
const { isRunnableStory, storyBackoffActive, retryAfterAt } = require('./autonomous-scheduler');
const { listExternalAgentJobs, summarizeExternalAgentJob } = require('./external-agent-jobs');

const RUNTIME_OPERATOR_VERSION = 'runtime_operator_v0_1';
const MAX_PREVIEW_CHARS = 600;

function oneLine(value, maxLength = MAX_PREVIEW_CHARS) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:\d{8,}:[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})/g, '<redacted>');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..') || /\0/.test(normalized)) return null;
  return normalized;
}

function baseResult(overrides = {}) {
  return {
    ok: false,
    stage: 'ralph_runtime_operator',
    version: RUNTIME_OPERATOR_VERSION,
    reason: null,
    story_id: null,
    story: null,
    runnable: false,
    candidate_patch_path: null,
    removed: [],
    skipped: [],
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: [],
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    next_action: 'inspect_runtime_operator_failure',
    ...overrides
  };
}

function storyNotFound(storyId) {
  return baseResult({ reason: 'story_not_found', story_id: safeStoryId(storyId), next_action: 'check_story_id' });
}

function readStoryRequired(rootDir, storyId) {
  const story = readStory(rootDir, storyId);
  return story ? { ok: true, story } : { ok: false, result: storyNotFound(storyId) };
}

function approvalPath(rootDir, approvalId) {
  const safe = String(approvalId || '').trim();
  if (!/^APR-[A-Z0-9_-]{1,120}$/.test(safe)) return null;
  return path.join(rootDir, '.ralph', 'approval-pending', `${safe}.json`);
}

function safeTmpPath(rootDir, relPath) {
  const safe = safeRelativePath(relPath);
  if (!safe || !safe.startsWith('.ralph/tmp/')) return null;
  const absolute = path.resolve(rootDir, safe);
  const prefix = path.resolve(rootDir, '.ralph', 'tmp');
  return absolute.startsWith(prefix) ? { rel: safe, abs: absolute } : null;
}

function candidatePatchLooksValid(text) {
  return /^diff --git /m.test(String(text || '')) && /^--- /m.test(String(text || '')) && /^\+\+\+ /m.test(String(text || ''));
}

function patchTouchedFiles(patchText) {
  const files = new Set();
  for (const line of String(patchText || '').split('\n')) {
    const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
    if (!match) continue;
    const target = safeRelativePath(match[2]);
    if (target) files.add(target);
  }
  return [...files].sort().slice(0, 50);
}

function storyStatus({ rootDir = process.cwd(), story_id } = {}) {
  const loaded = readStoryRequired(rootDir, story_id);
  if (!loaded.ok) return loaded.result;
  const story = loaded.story;
  return baseResult({
    ok: true,
    stage: 'ralph_story_status',
    reason: null,
    story_id: story.story_id,
    story: summarizeStory(story),
    current_phase: story.current_phase || null,
    blocked_reason: oneLine(story.blocked_reason || ''),
    current_candidate_patch_path: story.current_candidate_patch_path || null,
    current_sandbox_root: story.current_sandbox_root || null,
    patch_source: story.patch_source || null,
    last_fallback_result: story.last_fallback_result || null,
    next_action: 'inspect_runnable_or_tick_story'
  });
}

function explainRunnable({ rootDir = process.cwd(), story_id, now = new Date() } = {}) {
  const loaded = readStoryRequired(rootDir, story_id);
  if (!loaded.ok) return loaded.result;
  const story = loaded.story;
  const reasons = [];
  if (!['queued', 'running', 'waiting_approval'].includes(story.status)) reasons.push(`status_${story.status}_not_runnable`);
  if (['STOPPED', 'ESCALATED', 'DONE'].includes(story.current_phase)) reasons.push(`phase_${story.current_phase}_terminal`);
  if (storyBackoffActive(story, now)) reasons.push('retry_backoff_active');
  const retryAt = retryAfterAt(story);
  const runnable = isRunnableStory(story, { now });
  return baseResult({
    ok: true,
    stage: 'ralph_explain_runnable',
    reason: null,
    story_id: story.story_id,
    story: summarizeStory(story),
    runnable,
    reasons,
    retry_after_at: story.retry_after_at || null,
    retry_after_epoch_ms: retryAt,
    now: now.toISOString(),
    next_action: runnable ? 'story_can_be_scheduled_or_ticked' : 'resolve_runnable_blockers'
  });
}

function resumeWithCandidatePatch({ rootDir = process.cwd(), story_id, candidate_patch_path, now = new Date(), patch_source = 'operator_seeded_candidate_patch' } = {}) {
  const loaded = readStoryRequired(rootDir, story_id);
  if (!loaded.ok) return loaded.result;
  const story = loaded.story;
  const safePatch = safeTmpPath(rootDir, candidate_patch_path);
  if (!safePatch) return baseResult({ ok: false, stage: 'ralph_resume_with_candidate_patch', reason: 'candidate_patch_path_not_allowed', story_id: story.story_id, story: summarizeStory(story), next_action: 'provide_candidate_patch_under_ralph_tmp' });
  if (!fs.existsSync(safePatch.abs)) return baseResult({ ok: false, stage: 'ralph_resume_with_candidate_patch', reason: 'candidate_patch_not_found', story_id: story.story_id, story: summarizeStory(story), candidate_patch_path: safePatch.rel, next_action: 'write_candidate_patch_then_retry' });
  const text = fs.readFileSync(safePatch.abs, 'utf8');
  if (!candidatePatchLooksValid(text)) return baseResult({ ok: false, stage: 'ralph_resume_with_candidate_patch', reason: 'candidate_patch_invalid', story_id: story.story_id, story: summarizeStory(story), candidate_patch_path: safePatch.rel, next_action: 'provide_valid_unified_git_diff' });
  const filesTouched = patchTouchedFiles(text);
  if (filesTouched.length === 0) return baseResult({ ok: false, stage: 'ralph_resume_with_candidate_patch', reason: 'candidate_patch_files_unavailable', story_id: story.story_id, story: summarizeStory(story), candidate_patch_path: safePatch.rel, next_action: 'provide_patch_with_diff_git_headers' });
  const sandboxRoot = path.dirname(safePatch.rel).replace(/\\/g, '/');
  const updated = updateStory(story.story_id, {
    status: STORY_STATUSES.RUNNING,
    current_phase: 'PATCH_PREVIEW',
    current_candidate_patch_path: safePatch.rel,
    current_sandbox_root: sandboxRoot,
    blocked_reason: null,
    retry_after_at: null,
    patch_source,
    last_resume_result: {
      patch_source,
      candidate_patch_path: safePatch.rel,
      files_touched: filesTouched,
      diff_bytes: Buffer.byteLength(text, 'utf8'),
      resumed_at: now.toISOString()
    }
  }, { rootDir, now, event: 'story_resumed_with_candidate_patch' });
  return baseResult({
    ok: true,
    stage: 'ralph_resume_with_candidate_patch',
    reason: null,
    story_id: story.story_id,
    story: updated.summary,
    candidate_patch_path: safePatch.rel,
    sandbox_root: sandboxRoot,
    patch_source,
    files_touched: filesTouched,
    diff_bytes: Buffer.byteLength(text, 'utf8'),
    files_modified: [path.relative(rootDir, path.join(rootDir, '.ralph', 'stories', `${story.story_id}.json`)).replace(/\\/g, '/')],
    next_action: 'preview_candidate_patch_and_decide_apply'
  });
}

function storyRelatedJobs(rootDir, story) {
  const ids = new Set([story.current_job_id].filter(Boolean));
  const approvalId = story.current_approval_id || null;
  return listExternalAgentJobs(rootDir, { limit: 25 }).filter((job) => {
    if (ids.has(job.job_id)) return true;
    if (approvalId && job.approval_id === approvalId) return true;
    if (job.sandbox_root && story.current_sandbox_root && job.sandbox_root === story.current_sandbox_root) return true;
    if (job.candidate_patch_path && story.current_candidate_patch_path && job.candidate_patch_path === story.current_candidate_patch_path) return true;
    return false;
  });
}

function removePath(rootDir, relPath, { allowFile = true, allowDir = true } = {}) {
  const safe = safeRelativePath(relPath);
  if (!safe) return { ok: false, path: relPath, reason: 'path_not_allowed' };
  const absolute = path.resolve(rootDir, safe);
  if (!absolute.startsWith(path.resolve(rootDir, '.ralph'))) return { ok: false, path: safe, reason: 'not_ralph_runtime_path' };
  if (!fs.existsSync(absolute)) return { ok: true, path: safe, removed: false, reason: 'missing' };
  const stat = fs.statSync(absolute);
  if (stat.isDirectory() && !allowDir) return { ok: false, path: safe, reason: 'directory_not_allowed' };
  if (stat.isFile() && !allowFile) return { ok: false, path: safe, reason: 'file_not_allowed' };
  fs.rmSync(absolute, { recursive: stat.isDirectory(), force: true });
  return { ok: true, path: safe, removed: true, reason: null };
}

function cleanupStoryRuntime({ rootDir = process.cwd(), story_id, now = new Date(), include_story = false, include_approval = false } = {}) {
  const loaded = readStoryRequired(rootDir, story_id);
  if (!loaded.ok) return loaded.result;
  const story = loaded.story;
  const removed = [];
  const skipped = [];
  const candidates = [];
  const jobs = storyRelatedJobs(rootDir, story);
  for (const job of jobs) candidates.push(path.join('.ralph', 'external-agent-jobs', `${job.job_id}.json`).replace(/\\/g, '/'));
  if (story.current_sandbox_root) candidates.push(story.current_sandbox_root);
  else if (story.current_candidate_patch_path) candidates.push(path.dirname(story.current_candidate_patch_path).replace(/\\/g, '/'));
  if (include_approval && story.current_approval_id) {
    const approval = approvalPath(rootDir, story.current_approval_id);
    if (approval) candidates.push(path.relative(rootDir, approval).replace(/\\/g, '/'));
  }
  if (include_story) candidates.push(path.join('.ralph', 'stories', `${story.story_id}.json`).replace(/\\/g, '/'));
  const unique = Array.from(new Set(candidates.filter(Boolean)));
  for (const rel of unique) {
    const result = removePath(rootDir, rel);
    if (result.ok && result.removed) removed.push(result.path);
    else skipped.push(result);
  }
  const storyStillExists = Boolean(readStory(rootDir, story.story_id));
  return baseResult({
    ok: true,
    stage: 'ralph_cleanup_story_runtime',
    reason: null,
    story_id: story.story_id,
    story: storyStillExists ? summarizeStory(readStory(rootDir, story.story_id)) : null,
    removed,
    skipped,
    jobs: jobs.map(summarizeExternalAgentJob),
    files_modified: removed,
    next_action: include_story ? 'story_runtime_removed' : 'inspect_story_or_reset_runtime_metadata'
  });
}

function resetStoryRuntime({ rootDir = process.cwd(), story_id, now = new Date(), cleanup = true } = {}) {
  const loaded = readStoryRequired(rootDir, story_id);
  if (!loaded.ok) return loaded.result;
  const story = loaded.story;
  const cleanupResult = cleanup ? cleanupStoryRuntime({ rootDir, story_id, now, include_story: false, include_approval: false }) : null;
  const updated = updateStory(story.story_id, {
    status: STORY_STATUSES.QUEUED,
    current_phase: 'PLAN',
    current_approval_id: null,
    current_job_id: null,
    current_plan_hash: null,
    current_patch_hash: null,
    current_candidate_patch_path: null,
    current_sandbox_root: null,
    current_opencode_runtime_mode: null,
    current_opencode_mediator: null,
    blocked_reason: null,
    retry_after_at: null,
    patch_source: null,
    last_fallback_result: null,
    last_resume_result: null,
    last_gate_failure_summary: null,
    last_repair_instruction: null
  }, { rootDir, now, event: 'story_runtime_reset' });
  return baseResult({
    ok: true,
    stage: 'ralph_reset_story_runtime',
    reason: null,
    story_id: story.story_id,
    story: updated.summary,
    cleanup: cleanupResult ? { removed: cleanupResult.removed, skipped: cleanupResult.skipped } : null,
    files_modified: ['.ralph/stories/' + story.story_id + '.json', ...(cleanupResult?.removed || [])],
    next_action: 'run_ultraplan_for_story'
  });
}

module.exports = {
  RUNTIME_OPERATOR_VERSION,
  safeRelativePath,
  storyStatus,
  explainRunnable,
  resumeWithCandidatePatch,
  cleanupStoryRuntime,
  resetStoryRuntime,
  patchTouchedFiles,
  candidatePatchLooksValid
};
