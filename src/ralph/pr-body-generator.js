const DEFAULT_MAX_CHANGED_FILES = 50;
const DEFAULT_MAX_APPROVALS = 20;
const DEFAULT_MAX_GATES = 20;

function oneLine(value, maxLength = 400) {
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

function normalizePath(value) {
  const item = String(value || '').replace(/\\/g, '/').trim();
  if (!item || item.startsWith('/') || item.includes('..')) return null;
  return redactText(item, 240);
}

function normalizeList(value, limit = 50, maxLength = 240) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => redactText(item, maxLength)).filter(Boolean))).slice(0, limit);
}

function normalizeChangedFiles(changedFiles = [], limit = DEFAULT_MAX_CHANGED_FILES) {
  if (!Array.isArray(changedFiles)) return [];
  return changedFiles.map((item) => {
    if (typeof item === 'string') return normalizePath(item);
    if (item && typeof item === 'object') return normalizePath(item.path || item.filename || item.file || item.name);
    return null;
  }).filter(Boolean).slice(0, limit);
}

function normalizeApprovals(approvals = [], limit = DEFAULT_MAX_APPROVALS) {
  if (!Array.isArray(approvals)) return [];
  return approvals.map((approval) => {
    if (typeof approval === 'string') return { approval_id: redactText(approval, 120), approval_type: null, status: null, approved_by: null, approved_at: null };
    if (!approval || typeof approval !== 'object') return null;
    return {
      approval_id: redactText(approval.approval_id || approval.id || '', 120),
      approval_type: redactText(approval.approval_type || approval.type || '', 80) || null,
      status: redactText(approval.status || '', 80) || null,
      approved_by: redactText(approval.approved_by || '', 120) || null,
      approved_at: redactText(approval.approved_at || '', 80) || null
    };
  }).filter((approval) => approval && approval.approval_id).slice(0, limit);
}

function normalizeGateSummary(gates = {}, limit = DEFAULT_MAX_GATES) {
  const list = Array.isArray(gates) ? gates : Array.isArray(gates.gates) ? gates.gates : [];
  return list.map((gate) => ({
    id: redactText(gate.id || gate.name || gate.failed_gate || 'unknown', 120),
    ok: gate.ok === true,
    skipped: gate.skipped === true,
    required: gate.required === true,
    reason: redactText(gate.reason || '', 160) || null,
    exit_code: Number.isInteger(gate.exit_code) ? gate.exit_code : null
  })).slice(0, limit);
}

function checkbox(value) {
  return value ? '[x]' : '[ ]';
}

function collectPlanHash(story = {}, ultraplan = {}, approvals = []) {
  return story.current_plan_hash || ultraplan.plan_hash || ultraplan.current_plan_hash || approvals.find((approval) => approval.plan_hash)?.plan_hash || null;
}

function collectDiffHash(story = {}, approvals = [], explicit = {}) {
  return explicit.diff_hash || story.current_diff_hash || story.current_patch_hash || approvals.find((approval) => approval.post_exec_diff_hash)?.post_exec_diff_hash || approvals.find((approval) => approval.pre_exec_diff_hash)?.pre_exec_diff_hash || null;
}

function summarizeTasks(ultraplan = {}) {
  const tasks = Array.isArray(ultraplan.tasks) ? ultraplan.tasks : Array.isArray(ultraplan.plan?.tasks) ? ultraplan.plan.tasks : [];
  return tasks.map((task) => `- ${redactText(task.id || 'TASK', 40)}: ${redactText(task.title || task.objective || '', 180)}`).slice(0, 10);
}

function buildSafetyChecklist() {
  return [
    `${checkbox(true)} No production deploy from Telegram`,
    `${checkbox(true)} No production migration from Telegram`,
    `${checkbox(true)} No merge from Telegram`,
    `${checkbox(true)} No unrestricted shell`,
    `${checkbox(true)} No raw logs or secrets included`,
    `${checkbox(true)} No agent-initiated apply/commit/push/PR outside approval chain`,
    `${checkbox(true)} No production DB destructive changes`,
    `${checkbox(true)} No RLS disable`,
    `${checkbox(true)} No default branch direct mutation without approval path`
  ];
}

function buildPrBody({ story = {}, ultraplan = {}, changed_files = [], gates = {}, approvals = [], plan_hash = null, diff_hash = null } = {}) {
  const normalizedApprovals = normalizeApprovals(approvals);
  const normalizedGates = normalizeGateSummary(gates);
  const files = normalizeChangedFiles(changed_files.length ? changed_files : story.repository_files_modified || story.files_modified || story.requested_paths || []);
  const resolvedPlanHash = redactText(plan_hash || collectPlanHash(story, ultraplan, approvals), 120) || 'not_available';
  const resolvedDiffHash = redactText(diff_hash || collectDiffHash(story, approvals, { diff_hash }), 120) || 'not_available';
  const title = redactText(story.title || ultraplan.title || story.requirement || 'Ralph autonomous change', 160);
  const requirement = redactText(story.requirement || ultraplan.requirement || ultraplan.objective || '', 1200);
  const acceptance = normalizeList(story.acceptance_criteria || ultraplan.acceptance_criteria || [], 25, 300);
  const tasks = summarizeTasks(ultraplan);
  const gateOk = gates.ok === true || (normalizedGates.length > 0 && normalizedGates.every((gate) => gate.ok || gate.skipped));

  const lines = [
    `## Summary`,
    `- Story: ${redactText(story.story_id || 'unknown', 120)}`,
    `- Title: ${title}`,
    requirement ? `- Requirement: ${requirement}` : null,
    ``,
    `## Plan`,
    `- plan_hash: \`${resolvedPlanHash}\``,
    `- diff_hash: \`${resolvedDiffHash}\``,
    tasks.length ? tasks.join('\n') : '- No task summary available.',
    ``,
    `## Changed files`,
    files.length ? files.map((file) => `- \`${file}\``).join('\n') : '- No changed file list provided.',
    ``,
    `## Acceptance criteria`,
    acceptance.length ? acceptance.map((item) => `- ${item}`).join('\n') : '- Implementation satisfies the story requirement.',
    ``,
    `## Gates`,
    `- Overall: ${gateOk ? 'passed' : 'not confirmed'}`,
    normalizedGates.length ? normalizedGates.map((gate) => `- ${gate.ok ? 'PASS' : gate.skipped ? 'SKIP' : 'FAIL'} ${gate.id}${gate.reason ? ` — ${gate.reason}` : ''}`).join('\n') : '- Gate details not provided.',
    ``,
    `## Approvals`,
    normalizedApprovals.length ? normalizedApprovals.map((approval) => `- ${approval.approval_id}${approval.approval_type ? ` (${approval.approval_type})` : ''}${approval.status ? ` — ${approval.status}` : ''}${approval.approved_by ? ` by ${approval.approved_by}` : ''}`).join('\n') : '- Approval records not provided in generator input.',
    ``,
    `## Safety checklist`,
    buildSafetyChecklist().join('\n')
  ].filter((line) => line !== null && line !== undefined);

  return {
    ok: true,
    stage: 'pr_body_generator',
    title,
    body: lines.join('\n'),
    plan_hash: resolvedPlanHash,
    diff_hash: resolvedDiffHash,
    changed_files: files,
    approvals: normalizedApprovals,
    gates: normalizedGates,
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: 'review_pr_body_before_pr_creation'
  };
}

module.exports = {
  oneLine,
  redactText,
  normalizeChangedFiles,
  normalizeApprovals,
  normalizeGateSummary,
  buildSafetyChecklist,
  buildPrBody
};
