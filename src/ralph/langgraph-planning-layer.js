const crypto = require('node:crypto');
const { evaluateRisk, decideControlAction, targetEnv } = require('./risk-evaluator');
const { decideProductionChangePolicy } = require('./production-change-policy');

const PLANNING_LAYER_VERSION = 'langgraph_planning_layer_v0_1';

const PLANNING_NODES = Object.freeze({
  INTAKE: 'intake',
  PLAN: 'plan',
  RISK_EVALUATION: 'risk_evaluation',
  CONTROL_DECISION: 'control_decision',
  APPROVAL_ROUTING: 'approval_routing',
  EXECUTION_HANDOFF: 'execution_handoff',
  STOP: 'stop'
});

const NODE_ORDER = Object.freeze([
  PLANNING_NODES.INTAKE,
  PLANNING_NODES.PLAN,
  PLANNING_NODES.RISK_EVALUATION,
  PLANNING_NODES.CONTROL_DECISION,
  PLANNING_NODES.APPROVAL_ROUTING,
  PLANNING_NODES.EXECUTION_HANDOFF
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function normalizeStory(input = {}) {
  return {
    story_id: String(input.story_id || '').trim() || null,
    title: String(input.title || '').trim().slice(0, 160),
    objective: String(input.objective || input.prompt || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
    target_env: input.target_env || input.environment || 'local',
    mode: input.mode || 'approval',
    requested_paths: Array.isArray(input.requested_paths) ? input.requested_paths.map((item) => String(item || '').replace(/\\/g, '/')).filter(Boolean).slice(0, 50) : [],
    constraints: Array.isArray(input.constraints) ? input.constraints.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50) : []
  };
}

function buildPlanDraft(story) {
  const plannedFiles = story.requested_paths.length > 0 ? story.requested_paths : [];
  return {
    plan_version: PLANNING_LAYER_VERSION,
    story_id: story.story_id,
    title: story.title,
    objective: story.objective,
    target_env: story.target_env,
    mode: story.mode,
    planned_files: plannedFiles,
    constraints: story.constraints,
    acceptance_criteria: [
      'Implementation must stay within approved requested paths.',
      'Secret values must not be displayed, persisted, or logged.',
      'Production DB, RLS, auth, deploy, and migration effects require human approval.',
      'Generated diff must be separately reviewed before apply/commit/push/PR.'
    ],
    forbidden_actions: [
      'production destructive DB change',
      'secret value logging',
      'RLS disablement',
      'test deletion for success masking',
      'acceptance criteria mutation without approval',
      'main branch direct push',
      'force push',
      'git reset --hard',
      'unapproved production deploy',
      'execution with mismatched plan_hash'
    ]
  };
}

function routeForDecision(decision) {
  switch (decision?.action) {
    case 'auto_execute':
      return { next_node: PLANNING_NODES.EXECUTION_HANDOFF, reason: 'auto_execute_allowed' };
    case 'require_plan_approval':
      return { next_node: PLANNING_NODES.APPROVAL_ROUTING, approval_type: 'plan', reason: decision.reason };
    case 'require_diff_approval':
      return { next_node: PLANNING_NODES.APPROVAL_ROUTING, approval_type: 'diff', reason: decision.reason };
    case 'stop':
      return { next_node: PLANNING_NODES.STOP, reason: decision.reason };
    case 'escalate':
      return { next_node: PLANNING_NODES.STOP, reason: decision.reason };
    default:
      return { next_node: PLANNING_NODES.STOP, reason: 'unknown_control_decision' };
  }
}

function createPlanningGraph(input = {}) {
  const story = normalizeStory(input);
  const plan = buildPlanDraft(story);
  const risk = evaluateRisk(plan);
  const productionPolicy = decideProductionChangePolicy(plan, { mode: story.mode });
  const decision = productionPolicy.decision?.action && productionPolicy.decision.action !== 'auto_execute'
    ? productionPolicy.decision
    : decideControlAction(risk, { mode: story.mode, target_env: targetEnv(plan) });
  const route = routeForDecision(decision);
  const planHash = sha256Json(plan);

  return {
    ok: true,
    stage: 'langgraph_planning_layer',
    version: PLANNING_LAYER_VERSION,
    story,
    nodes: NODE_ORDER,
    edges: [
      ['intake', 'plan'],
      ['plan', 'risk_evaluation'],
      ['risk_evaluation', 'control_decision'],
      ['control_decision', route.next_node]
    ],
    plan,
    plan_hash: planHash,
    risk,
    production_policy: productionPolicy,
    control_decision: decision,
    route,
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
    next_action: route.next_node === PLANNING_NODES.EXECUTION_HANDOFF ? 'create_execution_preflight' : 'create_required_approval'
  };
}

module.exports = {
  PLANNING_LAYER_VERSION,
  PLANNING_NODES,
  NODE_ORDER,
  canonicalJson,
  sha256Json,
  normalizeStory,
  buildPlanDraft,
  routeForDecision,
  createPlanningGraph
};
