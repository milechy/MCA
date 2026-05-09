const { calculatePlanHash } = require('./hash');
const { createPlanningGraph } = require('./langgraph-planning-layer');
const { evaluateRisk, decideControlAction, targetEnv } = require('./risk-evaluator');
const { decideProductionChangePolicy } = require('./production-change-policy');

const ULTRAPLAN_VERSION = 'ultraplan_runner_v0_1';

function oneLine(value, maxLength = 4000) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function inferRequestedPaths(requirement) {
  const text = oneLine(requirement).toLowerCase();
  const paths = [];
  if (/test|spec|テスト|回帰/.test(text)) paths.push('tests/ralph/autonomous-generated.spec.js');
  if (/telegram|テレグラム/.test(text)) paths.push('src/telegram/handlers.js', 'tests/telegram/handlers.spec.js');
  if (/ralph|autonomous|自律|loop|ループ|ultraplan|plan/.test(text)) paths.push('src/ralph/autonomous-loop.js', 'tests/ralph/autonomous-loop.spec.js');
  if (/ui|画面|page|component|顧客|一覧|検索|pagination|ページネーション/.test(text)) paths.push('src/app/autonomous-generated.js', 'tests/e2e/autonomous-generated.spec.js');
  return Array.from(new Set(paths)).slice(0, 10);
}

function buildAcceptanceCriteria(story) {
  const base = Array.isArray(story.acceptance_criteria) && story.acceptance_criteria.length > 0
    ? story.acceptance_criteria
    : [
        'Implementation satisfies the submitted requirement.',
        'Relevant automated tests are added or updated.',
        'All configured local gates pass.',
        'Generated diff is reviewed before apply/commit/push/PR.'
      ];
  return Array.from(new Set(base.map((item) => oneLine(item, 300)).filter(Boolean))).slice(0, 25);
}

function buildTasks(story, requestedPaths) {
  return [
    {
      id: 'TASK-001',
      title: 'Analyze requirement and implementation surface',
      objective: story.requirement,
      requested_paths: [],
      expected_output: 'bounded implementation plan',
      agent: 'ralph'
    },
    {
      id: 'TASK-002',
      title: 'Generate candidate patch with OpenCode',
      objective: `Implement: ${story.requirement}`,
      requested_paths: requestedPaths,
      expected_output: 'candidate.patch',
      agent: 'opencode'
    },
    {
      id: 'TASK-003',
      title: 'Run gates and repair failures',
      objective: 'Run local gates and feed bounded failures back into OpenCode until green or retry exhaustion.',
      requested_paths: requestedPaths,
      expected_output: 'green gates or escalation',
      agent: 'ralph'
    }
  ];
}

function riskSubjectForPlan(plan) {
  return {
    story_id: plan.story_id,
    title: plan.title,
    requirement: plan.requirement,
    objective: plan.objective,
    mode: plan.mode,
    target_env: plan.target_env,
    requested_paths: plan.requested_paths,
    planned_files: plan.planned_files,
    acceptance_criteria: plan.acceptance_criteria,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      objective: task.objective,
      requested_paths: task.requested_paths,
      expected_output: task.expected_output,
      agent: task.agent
    }))
  };
}

function buildUltraPlan(story) {
  const requirement = oneLine(story.requirement || story.objective || story.prompt, 4000);
  const requestedPaths = Array.isArray(story.requested_paths) && story.requested_paths.length > 0
    ? story.requested_paths
    : inferRequestedPaths(requirement);
  const acceptanceCriteria = buildAcceptanceCriteria({ ...story, requirement });
  const planWithoutHash = {
    ultraplan_version: ULTRAPLAN_VERSION,
    story_id: story.story_id,
    title: oneLine(story.title || requirement, 160),
    requirement,
    objective: requirement,
    mode: story.mode || 'approval',
    target_env: story.target_env || 'local',
    requested_paths: requestedPaths,
    planned_files: requestedPaths,
    acceptance_criteria: acceptanceCriteria,
    tasks: buildTasks({ ...story, requirement }, requestedPaths),
    gate_expectations: [
      'pre-secret-scan',
      'telegram-tests',
      'supabase-local',
      'playwright-e2e',
      'post-secret-scan'
    ],
    approval_boundaries: [
      'plan approval when policy requires it',
      'diff approval before apply when required',
      'commit approval before commit',
      'push approval before push',
      'PR approval before PR creation'
    ],
    forbidden_actions: [
      'production deploy from Telegram',
      'production migration from Telegram',
      'merge from Telegram',
      'unrestricted shell',
      'raw logs',
      'agent-initiated apply/commit/push/PR without approval chain',
      'secret value display/persistence/logging'
    ]
  };
  return { ...planWithoutHash, plan_hash: calculatePlanHash(planWithoutHash) };
}

function evaluatePlanControls(story, plan) {
  const riskSubject = riskSubjectForPlan(plan);
  const planningGraph = createPlanningGraph({
    story_id: story.story_id,
    title: plan.title,
    objective: plan.objective,
    target_env: plan.target_env,
    mode: plan.mode,
    requested_paths: plan.requested_paths,
    constraints: []
  });
  const risk = evaluateRisk(riskSubject);
  const productionPolicy = decideProductionChangePolicy(riskSubject, { mode: plan.mode });
  const controlDecision = productionPolicy.decision?.action && productionPolicy.decision.action !== 'auto_execute'
    ? productionPolicy.decision
    : decideControlAction(risk, { mode: plan.mode, target_env: targetEnv(riskSubject) });
  return { riskSubject, planningGraph, risk, productionPolicy, controlDecision };
}

function buildUltraPlanRunnerResult(story, plan, { providerResult = null } = {}) {
  const controls = evaluatePlanControls(story, plan);
  return {
    ok: true,
    stage: 'ultraplan_runner',
    reason: null,
    version: ULTRAPLAN_VERSION,
    story_id: story.story_id,
    plan,
    plan_hash: plan.plan_hash,
    tasks: plan.tasks,
    acceptance_criteria: plan.acceptance_criteria,
    requested_paths: plan.requested_paths,
    risk_subject: controls.riskSubject,
    planning_graph: controls.planningGraph,
    risk: controls.risk,
    production_policy: controls.productionPolicy,
    control_decision: controls.controlDecision,
    provider: providerResult ? providerResult.provider : 'deterministic',
    fallback_used: providerResult ? Boolean(providerResult.fallback_used) : false,
    fallback_reason: providerResult ? providerResult.fallback_reason || null : null,
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
    next_action: controls.controlDecision.action === 'auto_execute' ? 'dispatch_opencode_candidate_patch' : 'create_required_approval'
  };
}

function storyRequiredFailure() {
  return {
    ok: false,
    stage: 'ultraplan_runner',
    reason: 'story_required',
    execution_connected: false,
    commands_executed: [],
    files_modified: [],
    repository_files_modified: []
  };
}

function runUltraPlan(story) {
  if (!story || !story.story_id) return storyRequiredFailure();
  return buildUltraPlanRunnerResult(story, buildUltraPlan(story));
}

async function runUltraPlanWithProvider(story, options = {}) {
  if (!story || !story.story_id) return storyRequiredFailure();
  const { generateUltraPlanWithProvider } = require('./ultraplan-provider');
  const providerResult = await generateUltraPlanWithProvider(story, options);
  if (!providerResult.ok || !providerResult.plan) return storyRequiredFailure();
  return buildUltraPlanRunnerResult(story, providerResult.plan, { providerResult });
}

module.exports = {
  ULTRAPLAN_VERSION,
  inferRequestedPaths,
  buildAcceptanceCriteria,
  buildTasks,
  riskSubjectForPlan,
  buildUltraPlan,
  evaluatePlanControls,
  buildUltraPlanRunnerResult,
  runUltraPlan,
  runUltraPlanWithProvider
};
