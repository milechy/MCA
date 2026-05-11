const path = require('node:path');

const GATEWAY_TYPES = Object.freeze({
  NEMOCLAW: 'nemoclaw',
  OPENCLAW: 'openclaw',
  GENERIC: 'generic'
});

const OPENCODE_RUNTIME_MODES = Object.freeze({
  NEMOCLAW_MEDIATED: 'nemoclaw-mediated',
  DEV_ONLY_NON_NEMOCLAW: 'dev-only-non-nemoclaw'
});

const GATEWAY_ACTIONS = Object.freeze({
  RUN_CANDIDATE_PATCH: 'run_candidate_patch'
});

const GATEWAY_STATUSES = Object.freeze({
  READY: 'ready',
  BLOCKED: 'blocked'
});

const DEFAULT_CANDIDATE_PATCH = 'candidate.patch';
const MAX_TASK_CHARS = 1000;

function normalizeGatewayType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.values(GATEWAY_TYPES).includes(normalized) ? normalized : null;
}

function normalizeGatewayName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) return null;
  return name;
}

function runtimeModeForGateway(gatewayType) {
  return gatewayType === GATEWAY_TYPES.NEMOCLAW ? OPENCODE_RUNTIME_MODES.NEMOCLAW_MEDIATED : OPENCODE_RUNTIME_MODES.DEV_ONLY_NON_NEMOCLAW;
}

function mediatorForGateway(gatewayType) {
  return gatewayType === GATEWAY_TYPES.NEMOCLAW ? 'nemoclaw' : gatewayType || null;
}

function gatewayIsDevOnly(gatewayType) {
  return gatewayType !== GATEWAY_TYPES.NEMOCLAW;
}

function devOnlyGatewayAllowed({ allow_dev_only_gateway = false, env = process.env } = {}) {
  return allow_dev_only_gateway === true || env.RALPH_EXTERNAL_AGENT_DEV_ONLY_GATEWAY_ALLOWED === 'true';
}

function normalizeTask(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TASK_CHARS);
}

function normalizeRequestedPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .map((filePath) => String(filePath || '').replace(/\\/g, '/').trim())
    .filter(Boolean)
    .filter((filePath) => !path.isAbsolute(filePath))
    .filter((filePath) => !filePath.split('/').includes('..'))
    .slice(0, 25);
}

function sandboxCandidatePatchPath(sandboxRoot) {
  const root = String(sandboxRoot || '').replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!root || path.isAbsolute(root) || root.split('/').includes('..')) return null;
  if (!root.startsWith('.ralph/tmp/')) return null;
  return `${root}/${DEFAULT_CANDIDATE_PATCH}`;
}

function makeBlocked(reason, extra = {}) {
  return {
    ok: false,
    status: GATEWAY_STATUSES.BLOCKED,
    stage: 'external_agent_gateway_policy',
    reason,
    gateway_type: extra.gateway_type || null,
    gateway_name: extra.gateway_name || null,
    mediator: mediatorForGateway(extra.gateway_type),
    opencode_runtime_mode: runtimeModeForGateway(extra.gateway_type),
    dev_only_gateway: gatewayIsDevOnly(extra.gateway_type),
    action: extra.action || null,
    sandbox_root: extra.sandbox_root || null,
    candidate_patch_path: null,
    requested_paths: extra.requested_paths || [],
    task_preview: extra.task_preview || '',
    execution_allowed: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false,
    raw_log_allowed: false,
    persistent_credentials_allowed: false,
    secret_display_allowed: false,
    secret_persistence_allowed: false,
    requires_telegram_authorization: true,
    requires_ralph_approval: true,
    requires_sandbox_preflight: true,
    requires_candidate_patch_preview: true,
    next_action: 'fix_external_gateway_request'
  };
}

function buildExternalGatewayPolicy({ gateway_type, gateway_name, action, sandbox_root, requested_paths, task, allow_dev_only_gateway = false, env = process.env } = {}) {
  const type = normalizeGatewayType(gateway_type);
  const name = normalizeGatewayName(gateway_name || gateway_type);
  const safePaths = normalizeRequestedPaths(requested_paths);
  const taskPreview = normalizeTask(task);
  const base = { gateway_type: type, gateway_name: name, action, sandbox_root, requested_paths: safePaths, task_preview: taskPreview };

  if (!type) return makeBlocked('gateway_type_not_allowed', base);
  if (!name) return makeBlocked('gateway_name_not_allowed', base);
  if (gatewayIsDevOnly(type) && !devOnlyGatewayAllowed({ allow_dev_only_gateway, env })) return makeBlocked('dev_only_gateway_requires_explicit_opt_in', base);
  if (action !== GATEWAY_ACTIONS.RUN_CANDIDATE_PATCH) return makeBlocked('gateway_action_not_allowed', base);
  if (!taskPreview) return makeBlocked('task_required', base);
  if (safePaths.length === 0) return makeBlocked('requested_paths_required', base);

  const candidatePath = sandboxCandidatePatchPath(sandbox_root);
  if (!candidatePath) return makeBlocked('sandbox_root_not_allowed', base);

  return {
    ok: true,
    status: GATEWAY_STATUSES.READY,
    stage: 'external_agent_gateway_policy',
    reason: null,
    gateway_type: type,
    gateway_name: name,
    mediator: mediatorForGateway(type),
    opencode_runtime_mode: runtimeModeForGateway(type),
    dev_only_gateway: gatewayIsDevOnly(type),
    action,
    sandbox_root,
    candidate_patch_path: candidatePath,
    requested_paths: safePaths,
    task_preview: taskPreview,
    execution_allowed: true,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false,
    raw_log_allowed: false,
    persistent_credentials_allowed: false,
    secret_display_allowed: false,
    secret_persistence_allowed: false,
    requires_telegram_authorization: true,
    requires_ralph_approval: true,
    requires_sandbox_preflight: true,
    requires_candidate_patch_preview: true,
    allowed_outputs: [candidatePath],
    bounded_metadata_only: true,
    next_action: type === GATEWAY_TYPES.NEMOCLAW ? 'run_opencode_through_nemoclaw_gateway' : 'run_dev_only_gateway_inside_approved_sandbox'
  };
}

function gatewayRuntimeDependencyApproved(policy, { explicit_runtime_approval = false } = {}) {
  return {
    ok: explicit_runtime_approval === true,
    stage: 'external_agent_gateway_runtime_dependency',
    reason: explicit_runtime_approval === true ? null : 'runtime_dependency_requires_separate_approval',
    gateway_type: policy?.gateway_type || null,
    gateway_name: policy?.gateway_name || null,
    mediator: policy?.mediator || mediatorForGateway(policy?.gateway_type),
    opencode_runtime_mode: policy?.opencode_runtime_mode || runtimeModeForGateway(policy?.gateway_type),
    dev_only_gateway: policy?.dev_only_gateway === true,
    runtime_dependency_allowed: explicit_runtime_approval === true,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false
  };
}

module.exports = {
  GATEWAY_TYPES,
  OPENCODE_RUNTIME_MODES,
  GATEWAY_ACTIONS,
  GATEWAY_STATUSES,
  DEFAULT_CANDIDATE_PATCH,
  normalizeGatewayType,
  normalizeGatewayName,
  runtimeModeForGateway,
  mediatorForGateway,
  gatewayIsDevOnly,
  devOnlyGatewayAllowed,
  normalizeTask,
  normalizeRequestedPaths,
  sandboxCandidatePatchPath,
  buildExternalGatewayPolicy,
  gatewayRuntimeDependencyApproved
};
