const fs = require('node:fs');
const path = require('node:path');
const { listStories, STORY_STATUSES } = require('./story-queue');

const DASHBOARD_VERSION = 'ralph_dashboard_v0_1';
const DEFAULT_RECENT_LIMIT = 25;

function oneLine(value, maxLength = 500) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactText(value, maxLength = 1000) {
  return oneLine(value, maxLength)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s`'\"]+/gi, '$1=[REDACTED]');
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function safeReadJsonl(filePath, limit = DEFAULT_RECENT_LIMIT) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(100, limit)))
    .map((line) => {
      try { return JSON.parse(line); } catch (_error) { return null; }
    })
    .filter(Boolean);
}

function normalizePath(value) {
  const item = String(value || '').replace(/\\/g, '/').trim();
  if (!item || item.startsWith('/') || item.includes('..')) return null;
  return redactText(item, 240);
}

function normalizeStringList(value, limit = 25, maxLength = 240) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => redactText(item, maxLength)).filter(Boolean))).slice(0, limit);
}

function nextActionForStory(story = {}) {
  if (story.next_action) return redactText(story.next_action, 120);
  if (story.status === STORY_STATUSES.QUEUED) return 'run_ultraplan_for_story';
  if (story.status === STORY_STATUSES.WAITING_APPROVAL) return 'approve_or_modify_story_before_resume';
  if (story.status === STORY_STATUSES.FAILED) return 'inspect_failure_and_escalation';
  if (story.status === STORY_STATUSES.COMPLETED) return 'story_complete';
  if (story.status === STORY_STATUSES.STOPPED) return 'story_stopped';
  if (story.current_phase) return `advance_${String(story.current_phase).toLowerCase()}`;
  return 'inspect_story';
}

function summarizeStoryForDashboard(story = {}) {
  return {
    story_id: redactText(story.story_id || '', 120),
    title: redactText(story.title || '', 160),
    status: redactText(story.status || '', 80),
    current_phase: redactText(story.current_phase || '', 80) || null,
    blocked_reason: redactText(story.blocked_reason || '', 200) || null,
    current_approval_id: redactText(story.current_approval_id || '', 120) || null,
    current_job_id: redactText(story.current_job_id || '', 120) || null,
    current_plan_hash: redactText(story.current_plan_hash || '', 120) || null,
    attempts: Number.isInteger(story.attempts) ? story.attempts : 0,
    max_attempts: Number.isInteger(story.max_attempts) ? story.max_attempts : null,
    labels: normalizeStringList(story.labels || [], 25, 80),
    requested_paths: normalizeStringList(story.requested_paths || [], 25, 240),
    github_issue: story.github_issue ? {
      issue_number: story.github_issue.issue_number || null,
      title: redactText(story.github_issue.title || '', 160),
      url: redactText(story.github_issue.url || '', 240) || null,
      labels: normalizeStringList(story.github_issue.labels || [], 25, 80)
    } : null,
    updated_at: redactText(story.updated_at || '', 80) || null,
    next_action: nextActionForStory(story)
  };
}

function groupStories(stories = []) {
  const groups = {
    active: [],
    waiting_approval: [],
    failed: [],
    completed: [],
    stopped: []
  };
  for (const story of stories.map(summarizeStoryForDashboard)) {
    if (story.status === STORY_STATUSES.WAITING_APPROVAL) groups.waiting_approval.push(story);
    else if (story.status === STORY_STATUSES.FAILED) groups.failed.push(story);
    else if (story.status === STORY_STATUSES.COMPLETED) groups.completed.push(story);
    else if (story.status === STORY_STATUSES.STOPPED) groups.stopped.push(story);
    else groups.active.push(story);
  }
  return groups;
}

function approvalDir(rootDir) {
  return path.join(rootDir, '.ralph', 'approval-pending');
}

function readApprovals(rootDir, limit = DEFAULT_RECENT_LIMIT) {
  const dir = approvalDir(rootDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(safeReadJson)
    .filter(Boolean)
    .map((approval) => ({
      approval_id: redactText(approval.approval_id || '', 120),
      approval_type: redactText(approval.approval_type || '', 80) || null,
      story_id: redactText(approval.story_id || '', 120) || null,
      status: redactText(approval.status || '', 80) || null,
      requested_action: redactText(approval.requested_action || '', 120) || null,
      plan_hash: redactText(approval.plan_hash || '', 120) || null,
      pre_exec_diff_hash: redactText(approval.pre_exec_diff_hash || '', 120) || null,
      post_exec_diff_hash: redactText(approval.post_exec_diff_hash || '', 120) || null,
      approved_by: redactText(approval.approved_by || '', 120) || null,
      approved_at: redactText(approval.approved_at || '', 80) || null,
      expires_at: redactText(approval.expires_at || '', 80) || null,
      next_action: approval.status === 'pending' ? 'approve_deny_or_modify' : 'inspect_approval_record'
    }));
}

function logsDir(rootDir) {
  return path.join(rootDir, '.ralph', 'logs');
}

function normalizeAuditEvent(event = {}) {
  return {
    timestamp: redactText(event.timestamp || event.at || '', 80) || null,
    event: redactText(event.event || event.action || '', 160) || null,
    story_id: redactText(event.story_id || event.summary?.story_id || '', 120) || null,
    approval_id: redactText(event.approval_id || '', 120) || null,
    stage: redactText(event.stage || event.summary?.stage || '', 160) || null,
    status: redactText(event.status || '', 80) || null,
    reason: redactText(event.reason || event.summary?.reason || '', 200) || null
  };
}

function readRecentAuditEvents(rootDir, limit = DEFAULT_RECENT_LIMIT) {
  const auditEvents = safeReadJsonl(path.join(logsDir(rootDir), 'audit.jsonl'), limit).map(normalizeAuditEvent);
  const executionEvents = safeReadJsonl(path.join(logsDir(rootDir), 'execution.jsonl'), limit).map(normalizeAuditEvent);
  return [...auditEvents, ...executionEvents]
    .filter((event) => event.timestamp || event.event || event.stage)
    .slice(-Math.max(1, Math.min(100, limit)));
}

function summarizeJobsAndGates(events = []) {
  const jobs = [];
  const gates = [];
  for (const event of events) {
    if (event.stage && event.stage.includes('gate')) gates.push(event);
    if (event.event && event.event.includes('opencode')) jobs.push(event);
  }
  return {
    jobs: jobs.slice(-DEFAULT_RECENT_LIMIT),
    gates: gates.slice(-DEFAULT_RECENT_LIMIT)
  };
}

function dashboardCounts(groups, approvals) {
  return {
    active: groups.active.length,
    waiting_approval: groups.waiting_approval.length,
    failed: groups.failed.length,
    completed: groups.completed.length,
    stopped: groups.stopped.length,
    approvals: approvals.length,
    pending_approvals: approvals.filter((approval) => approval.status === 'pending').length
  };
}

function generateDashboard({ rootDir = process.cwd(), now = new Date(), story_limit = 100, recent_limit = DEFAULT_RECENT_LIMIT } = {}) {
  const stories = listStories({ rootDir, limit: story_limit });
  const groups = groupStories(stories);
  const approvals = readApprovals(rootDir, recent_limit);
  const recent_audit_events = readRecentAuditEvents(rootDir, recent_limit);
  const recent = summarizeJobsAndGates(recent_audit_events);
  return {
    ok: true,
    stage: 'ralph_dashboard',
    version: DASHBOARD_VERSION,
    generated_at: now.toISOString(),
    counts: dashboardCounts(groups, approvals),
    stories: groups,
    approvals,
    jobs: recent.jobs,
    gates: recent.gates,
    recent_audit_events,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: groups.waiting_approval.length > 0 ? 'resolve_pending_approvals' : groups.active.length > 0 ? 'run_autonomous_scheduler_tick' : 'wait_for_new_story'
  };
}

function dashboardToMarkdown(dashboard) {
  const lines = [
    `# Ralph Dashboard`,
    ``,
    `Generated: ${dashboard.generated_at}`,
    ``,
    `## Counts`,
    `- Active: ${dashboard.counts.active}`,
    `- Waiting approval: ${dashboard.counts.waiting_approval}`,
    `- Failed: ${dashboard.counts.failed}`,
    `- Completed: ${dashboard.counts.completed}`,
    `- Stopped: ${dashboard.counts.stopped}`,
    `- Pending approvals: ${dashboard.counts.pending_approvals}`,
    ``,
    `## Active stories`,
    ...(dashboard.stories.active.length ? dashboard.stories.active.map((story) => `- ${story.story_id}: ${story.title} — ${story.current_phase || story.status}; next: ${story.next_action}`) : ['- None']),
    ``,
    `## Waiting approval`,
    ...(dashboard.stories.waiting_approval.length ? dashboard.stories.waiting_approval.map((story) => `- ${story.story_id}: ${story.title}; approval: ${story.current_approval_id || 'unknown'}; next: ${story.next_action}`) : ['- None']),
    ``,
    `## Failed stories`,
    ...(dashboard.stories.failed.length ? dashboard.stories.failed.map((story) => `- ${story.story_id}: ${story.title}; reason: ${story.blocked_reason || 'unknown'}; next: ${story.next_action}`) : ['- None']),
    ``,
    `## Completed stories`,
    ...(dashboard.stories.completed.length ? dashboard.stories.completed.map((story) => `- ${story.story_id}: ${story.title}`) : ['- None']),
    ``,
    `## Recent audit events`,
    ...(dashboard.recent_audit_events.length ? dashboard.recent_audit_events.map((event) => `- ${event.timestamp || 'unknown'} ${event.event || event.stage || 'event'}${event.story_id ? ` story=${event.story_id}` : ''}${event.reason ? ` reason=${event.reason}` : ''}`) : ['- None'])
  ];
  return lines.join('\n');
}

module.exports = {
  DASHBOARD_VERSION,
  oneLine,
  redactText,
  normalizePath,
  summarizeStoryForDashboard,
  groupStories,
  readApprovals,
  readRecentAuditEvents,
  summarizeJobsAndGates,
  generateDashboard,
  dashboardToMarkdown
};
