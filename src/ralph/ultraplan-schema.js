const { calculatePlanHash } = require('./hash');

const FORBIDDEN_PLAN_ACTION_PATTERNS = [
  /\bapply\b/i,
  /\bcommit\b/i,
  /\bpush\b/i,
  /\bpull\s*request\b/i,
  /\bPR\b/,
  /\bmerge\b/i,
  /\bdeploy\b/i,
  /\bmigration\b/i,
  /\bmigrate\b/i,
  /\bunrestricted\s+shell\b/i,
  /\bproduction\s+(database|db|deploy|migration)\b/i,
  /\bdisable\s+RLS\b/i
];

function oneLine(value, maxLength = 4000) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeStringList(value, limit = 50, maxLength = 300) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => oneLine(item, maxLength)).filter(Boolean))).slice(0, limit);
}

function normalizePath(value) {
  const item = String(value || '').replace(/\\/g, '/').trim();
  if (!item || item.startsWith('/') || item.includes('..')) return null;
  return item;
}

function normalizePathList(value, limit = 50) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(normalizePath).filter(Boolean))).slice(0, limit);
}

function normalizeTask(task = {}, index = 0) {
  const id = oneLine(task.id || `TASK-${String(index + 1).padStart(3, '0')}`, 40);
  const title = oneLine(task.title || '', 160);
  const objective = oneLine(task.objective || '', 1000);
  const expected_output = oneLine(task.expected_output || 'bounded implementation artifact', 200);
  const agent = oneLine(task.agent || 'ralph', 40);
  const requested_paths = normalizePathList(task.requested_paths || [], 25);
  if (!title || !objective) return { ok: false, reason: 'task_title_and_objective_required' };
  return {
    ok: true,
    task: { id, title, objective, requested_paths, expected_output, agent }
  };
}

function taskRequestsForbiddenAction(task) {
  const text = [task.title, task.objective, task.expected_output].filter(Boolean).join(' ');
  return FORBIDDEN_PLAN_ACTION_PATTERNS.some((pattern) => pattern.test(text));
}

function validateUltraPlanShape(plan = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, reason: 'plan_object_required' };
  }
  if (!oneLine(plan.story_id, 100)) return { ok: false, reason: 'story_id_required' };
  if (!oneLine(plan.requirement || plan.objective, 4000)) return { ok: false, reason: 'requirement_required' };
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return { ok: false, reason: 'tasks_required' };
  if (plan.tasks.length > 10) return { ok: false, reason: 'too_many_tasks' };
  return { ok: true };
}

function canonicalizeUltraPlan(plan = {}, fallbackPlan = {}) {
  const shape = validateUltraPlanShape(plan);
  if (!shape.ok) return shape;
  const normalizedTasks = [];
  for (let index = 0; index < plan.tasks.length; index += 1) {
    const normalized = normalizeTask(plan.tasks[index], index);
    if (!normalized.ok) return normalized;
    if (taskRequestsForbiddenAction(normalized.task)) return { ok: false, reason: 'task_requests_forbidden_direct_action', task_id: normalized.task.id };
    normalizedTasks.push(normalized.task);
  }
  const requirement = oneLine(plan.requirement || plan.objective || fallbackPlan.requirement, 4000);
  const requestedPaths = normalizePathList(plan.requested_paths || fallbackPlan.requested_paths || [], 50);
  const canonicalWithoutHash = {
    ultraplan_version: oneLine(plan.ultraplan_version || fallbackPlan.ultraplan_version || 'ultraplan_runner_v0_1', 80),
    story_id: oneLine(plan.story_id || fallbackPlan.story_id, 100),
    title: oneLine(plan.title || fallbackPlan.title || requirement, 160),
    requirement,
    objective: oneLine(plan.objective || requirement, 4000),
    mode: oneLine(plan.mode || fallbackPlan.mode || 'approval', 40),
    target_env: oneLine(plan.target_env || fallbackPlan.target_env || 'local', 40),
    requested_paths: requestedPaths,
    planned_files: normalizePathList(plan.planned_files || requestedPaths, 50),
    acceptance_criteria: normalizeStringList(plan.acceptance_criteria || fallbackPlan.acceptance_criteria || [], 25, 300),
    tasks: normalizedTasks,
    gate_expectations: normalizeStringList(plan.gate_expectations || fallbackPlan.gate_expectations || [], 20, 120),
    approval_boundaries: normalizeStringList(plan.approval_boundaries || fallbackPlan.approval_boundaries || [], 20, 160),
    forbidden_actions: normalizeStringList(plan.forbidden_actions || fallbackPlan.forbidden_actions || [], 20, 160)
  };
  return {
    ok: true,
    plan: {
      ...canonicalWithoutHash,
      plan_hash: calculatePlanHash(canonicalWithoutHash)
    }
  };
}

module.exports = {
  FORBIDDEN_PLAN_ACTION_PATTERNS,
  oneLine,
  normalizeStringList,
  normalizePathList,
  validateUltraPlanShape,
  canonicalizeUltraPlan,
  taskRequestsForbiddenAction
};
