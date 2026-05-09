const PLANNING_PROVIDERS = Object.freeze({
  DETERMINISTIC: 'deterministic',
  GEMINI: 'gemini'
});

const EXECUTION_PROVIDERS = Object.freeze({
  KIMI: 'kimi'
});

const EXECUTION_MEDIATORS = Object.freeze({
  NEMOCLAW: 'nemoclaw'
});

const SECRET_ENV_KEYS = Object.freeze({
  GEMINI_API_KEY: 'GEMINI_API_KEY',
  KIMI_API_KEY: 'KIMI_API_KEY'
});

const LEGACY_ENV_KEYS = Object.freeze({
  ULTRAPLAN_PROVIDER: 'RALPH_ULTRAPLAN_PROVIDER',
  ULTRAPLAN_LLM_API_KEY: 'RALPH_ULTRAPLAN_LLM_API_KEY'
});

function oneLine(value, maxLength = 300) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactValue(value) {
  if (!value) return null;
  return '<set:redacted>';
}

function normalizePlanningProvider(value) {
  const provider = String(value || PLANNING_PROVIDERS.DETERMINISTIC).trim().toLowerCase();
  return Object.values(PLANNING_PROVIDERS).includes(provider) ? provider : null;
}

function normalizeExecutionProvider(value) {
  const provider = String(value || EXECUTION_PROVIDERS.KIMI).trim().toLowerCase();
  return Object.values(EXECUTION_PROVIDERS).includes(provider) ? provider : null;
}

function normalizeMediator(value) {
  const mediator = String(value || EXECUTION_MEDIATORS.NEMOCLAW).trim().toLowerCase();
  return Object.values(EXECUTION_MEDIATORS).includes(mediator) ? mediator : null;
}

function envPresent(env, key) {
  return typeof env[key] === 'string' && env[key].length > 0;
}

function buildProviderConfig({ env = process.env } = {}) {
  const rawPlanningProvider = env.RALPH_PLANNING_PROVIDER || env[LEGACY_ENV_KEYS.ULTRAPLAN_PROVIDER] || PLANNING_PROVIDERS.DETERMINISTIC;
  const planningProvider = normalizePlanningProvider(rawPlanningProvider) || PLANNING_PROVIDERS.DETERMINISTIC;
  const executionProvider = normalizeExecutionProvider(env.RALPH_EXECUTION_PROVIDER || EXECUTION_PROVIDERS.KIMI) || EXECUTION_PROVIDERS.KIMI;
  const executionMediator = normalizeMediator(env.RALPH_EXECUTION_MEDIATOR || EXECUTION_MEDIATORS.NEMOCLAW) || EXECUTION_MEDIATORS.NEMOCLAW;
  const geminiApiKeyPresent = envPresent(env, SECRET_ENV_KEYS.GEMINI_API_KEY) || envPresent(env, LEGACY_ENV_KEYS.ULTRAPLAN_LLM_API_KEY);
  const kimiApiKeyPresent = envPresent(env, SECRET_ENV_KEYS.KIMI_API_KEY);

  return {
    ok: true,
    stage: 'provider_config',
    planning: {
      provider: planningProvider,
      role: 'planning',
      model_family: planningProvider === PLANNING_PROVIDERS.GEMINI ? 'gemini' : 'deterministic',
      api_key_env: planningProvider === PLANNING_PROVIDERS.GEMINI ? SECRET_ENV_KEYS.GEMINI_API_KEY : null,
      legacy_api_key_env: planningProvider === PLANNING_PROVIDERS.GEMINI ? LEGACY_ENV_KEYS.ULTRAPLAN_LLM_API_KEY : null,
      api_key_present: planningProvider === PLANNING_PROVIDERS.GEMINI ? geminiApiKeyPresent : false,
      api_key_value: redactValue(planningProvider === PLANNING_PROVIDERS.GEMINI && geminiApiKeyPresent ? 'present' : ''),
      default_fallback_provider: PLANNING_PROVIDERS.DETERMINISTIC,
      raw_provider: oneLine(rawPlanningProvider, 80)
    },
    execution: {
      provider: executionProvider,
      role: 'implementation_repair_code_generation',
      model_family: 'kimi',
      api_key_env: SECRET_ENV_KEYS.KIMI_API_KEY,
      api_key_present: kimiApiKeyPresent,
      api_key_value: redactValue(kimiApiKeyPresent ? 'present' : ''),
      mediated_by: executionMediator,
      direct_policy_override_allowed: false,
      apply_allowed: false,
      commit_allowed: false,
      push_allowed: false,
      pr_allowed: false,
      merge_allowed: false,
      deploy_allowed: false,
      migration_allowed: false,
      secret_access_allowed: false
    },
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: [],
    next_action: planningProvider === PLANNING_PROVIDERS.GEMINI ? 'run_gemini_planning_provider_or_fallback' : 'run_deterministic_ultraplan_provider'
  };
}

function validateProviderConfig(config = {}) {
  if (!config || typeof config !== 'object') return { ok: false, reason: 'provider_config_required' };
  const planningProvider = normalizePlanningProvider(config.planning?.provider);
  if (!planningProvider) return { ok: false, reason: 'planning_provider_not_allowed' };
  const executionProvider = normalizeExecutionProvider(config.execution?.provider);
  if (!executionProvider) return { ok: false, reason: 'execution_provider_not_allowed' };
  const mediator = normalizeMediator(config.execution?.mediated_by);
  if (mediator !== EXECUTION_MEDIATORS.NEMOCLAW) return { ok: false, reason: 'execution_mediator_must_be_nemoclaw' };
  if (config.execution?.direct_policy_override_allowed === true) return { ok: false, reason: 'execution_policy_override_not_allowed' };
  return { ok: true, reason: null };
}

function safeProviderConfig(config = {}) {
  const built = config.stage === 'provider_config' ? config : buildProviderConfig({ env: {} });
  return {
    ok: built.ok === true,
    stage: 'provider_config_safe_summary',
    planning: {
      provider: built.planning?.provider || PLANNING_PROVIDERS.DETERMINISTIC,
      role: built.planning?.role || 'planning',
      model_family: built.planning?.model_family || 'deterministic',
      api_key_env: built.planning?.api_key_env || null,
      api_key_present: built.planning?.api_key_present === true,
      api_key_value: built.planning?.api_key_present ? '<set:redacted>' : null,
      default_fallback_provider: PLANNING_PROVIDERS.DETERMINISTIC
    },
    execution: {
      provider: built.execution?.provider || EXECUTION_PROVIDERS.KIMI,
      role: built.execution?.role || 'implementation_repair_code_generation',
      model_family: built.execution?.model_family || 'kimi',
      api_key_env: built.execution?.api_key_env || SECRET_ENV_KEYS.KIMI_API_KEY,
      api_key_present: built.execution?.api_key_present === true,
      api_key_value: built.execution?.api_key_present ? '<set:redacted>' : null,
      mediated_by: built.execution?.mediated_by || EXECUTION_MEDIATORS.NEMOCLAW,
      direct_policy_override_allowed: false,
      apply_allowed: false,
      commit_allowed: false,
      push_allowed: false,
      pr_allowed: false,
      merge_allowed: false,
      deploy_allowed: false,
      migration_allowed: false,
      secret_access_allowed: false
    },
    execution_connected: false,
    commands_executed: [],
    repository_files_modified: []
  };
}

module.exports = {
  PLANNING_PROVIDERS,
  EXECUTION_PROVIDERS,
  EXECUTION_MEDIATORS,
  SECRET_ENV_KEYS,
  LEGACY_ENV_KEYS,
  oneLine,
  redactValue,
  normalizePlanningProvider,
  normalizeExecutionProvider,
  normalizeMediator,
  buildProviderConfig,
  validateProviderConfig,
  safeProviderConfig
};
