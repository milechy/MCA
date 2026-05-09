const PROVIDER_ROLES = Object.freeze({
  PLANNING: 'planning',
  EXECUTION: 'execution'
});

const PLANNING_PROVIDERS = Object.freeze({
  DETERMINISTIC: 'deterministic',
  GEMINI: 'gemini'
});

const EXECUTION_PROVIDERS = Object.freeze({
  KIMI_OPENCODE: 'kimi-opencode'
});

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
const DEFAULT_KIMI_MODEL = 'kimi-k2';

function oneLine(value, maxLength = 240) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactSecret(value) {
  if (!value) return null;
  return '<redacted:set>';
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeProvider(value, allowed, fallback) {
  const normalized = String(value || fallback || '').trim().toLowerCase();
  return Object.values(allowed).includes(normalized) ? normalized : fallback;
}

function planningProviderEnabled(env = process.env) {
  return normalizeProvider(env.RALPH_PLANNING_PROVIDER || env.RALPH_ULTRAPLAN_PROVIDER, PLANNING_PROVIDERS, PLANNING_PROVIDERS.DETERMINISTIC);
}

function executionProvider(env = process.env) {
  return normalizeProvider(env.RALPH_EXECUTION_PROVIDER || EXECUTION_PROVIDERS.KIMI_OPENCODE, EXECUTION_PROVIDERS, EXECUTION_PROVIDERS.KIMI_OPENCODE);
}

function buildPlanningProviderConfig(env = process.env) {
  const provider = planningProviderEnabled(env);
  const apiKey = env.GEMINI_API_KEY || env.RALPH_GEMINI_API_KEY || env.RALPH_ULTRAPLAN_LLM_API_KEY || '';
  const model = oneLine(env.RALPH_GEMINI_MODEL || env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, 120);
  return {
    ok: provider === PLANNING_PROVIDERS.DETERMINISTIC || hasValue(apiKey),
    role: PROVIDER_ROLES.PLANNING,
    provider,
    model,
    api_key_present: hasValue(apiKey),
    api_key_preview: redactSecret(apiKey),
    secret_env_names: ['GEMINI_API_KEY', 'RALPH_GEMINI_API_KEY'],
    fallback_provider: PLANNING_PROVIDERS.DETERMINISTIC,
    fallback_allowed: true,
    reason: provider === PLANNING_PROVIDERS.GEMINI && !hasValue(apiKey) ? 'gemini_api_key_missing' : null,
    execution_allowed: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    raw_secret_allowed: false,
    next_action: provider === PLANNING_PROVIDERS.GEMINI ? 'generate_ultraplan_with_gemini_provider' : 'generate_deterministic_ultraplan'
  };
}

function buildExecutionProviderConfig(env = process.env) {
  const provider = executionProvider(env);
  const apiKey = env.KIMI_API_KEY || env.RALPH_KIMI_API_KEY || '';
  const model = oneLine(env.RALPH_KIMI_MODEL || env.KIMI_MODEL || DEFAULT_KIMI_MODEL, 120);
  return {
    ok: true,
    role: PROVIDER_ROLES.EXECUTION,
    provider,
    model,
    api_key_present: hasValue(apiKey),
    api_key_preview: redactSecret(apiKey),
    secret_env_names: ['KIMI_API_KEY', 'RALPH_KIMI_API_KEY'],
    runtime_surface: 'opencode-through-nemoclaw',
    mediator: 'nemoclaw',
    opencode_runtime_mode: 'nemoclaw-mediated',
    policy_override_allowed: false,
    direct_execution_allowed: false,
    apply_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_allowed: false,
    deploy_allowed: false,
    migration_allowed: false,
    unrestricted_shell_allowed: false,
    raw_secret_allowed: false,
    next_action: 'dispatch_kimi_opencode_through_nemoclaw_policy'
  };
}

function buildProviderConfig(env = process.env) {
  const planning = buildPlanningProviderConfig(env);
  const execution = buildExecutionProviderConfig(env);
  return {
    ok: planning.ok && execution.ok,
    stage: 'provider_config',
    planning,
    execution,
    role_boundary: {
      gemini_role: 'planning/decomposition/risk-aware UltraPlan generation only',
      kimi_role: 'implementation/repair/code generation only through OpenCode mediated by NemoClaw',
      policy_owner: 'ralph-nemoclaw',
      kimi_policy_override_allowed: false,
      gemini_execution_allowed: false,
      model_direct_apply_allowed: false,
      model_direct_commit_allowed: false,
      model_direct_push_allowed: false,
      model_direct_pr_allowed: false,
      model_direct_deploy_allowed: false,
      model_direct_migration_allowed: false
    },
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: planning.ok ? 'use_configured_provider_roles' : 'fallback_to_deterministic_planning'
  };
}

module.exports = {
  PROVIDER_ROLES,
  PLANNING_PROVIDERS,
  EXECUTION_PROVIDERS,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_KIMI_MODEL,
  oneLine,
  redactSecret,
  buildPlanningProviderConfig,
  buildExecutionProviderConfig,
  buildProviderConfig
};
